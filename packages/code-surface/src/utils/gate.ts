/** 门的几段文字：给模型的使用说明（连同常驻模块的声明与其余模块的索引）、要补声明时的回执、程序跑完的回执。都不碰实例状态。 */

import { isBlank, isEmpty, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeProgramRequest, CodeProgramResult, CompletedCall, GrantedModule, MountedCapabilityModule } from '../types/code-surface.js'
import type { CodeGateReply, ProgramModelContentPart, ProgramToolResult, RunProgramInput } from '../types/gate.js'

import { ProgramModuleDeclarations } from './compiler.js'
import { keepTail } from './program.js'

/** 怎么写一段交给门的程序：对所有空间都成立的那几条。例子只用两个空间都常驻的 `velar:shell`。 */
const GateRules = [
  '交一段 JavaScript ES 模块：import 能力模块（如 `import { run } from \'velar:shell\'`），顶层直接 await，用 export 交出你要看的东西——`export default` 或具名导出都行，有具名导出时按名字分开交回。',
  `能力返回的东西落在程序的变量里，不进你的上下文；只有导出的值与 console.log 的输出会回来。要看多少由你在程序里定：先看大小，筛好、切好再导出。字符串原样交回，别的按 JSON；一次最多交回 ${CodeSurfaceLimits.resultChars} 字符（导出的值 ${CodeSurfaceLimits.valueChars}、日志 ${CodeSurfaceLimits.logChars}），超出的截掉并说明。`,
  '程序先按声明过类型检查再执行：没过就一行都不执行，回带代码帧的诊断。改的时候传 edits（oldText 照原文一字不差、在程序里唯一，newText 写新的），不用整份重发。',
  '大段文本（文件正文、补丁）放进 blobs，程序里 `import { blobs } from \'velar:program\'` 按名字取，不写进源码。',
  '能力调用失败在程序里是能 try/catch 的异常，只有 error.code 与 error.message；要用户点头的操作（危险命令、写敏感文件、落回）在那次调用里自己会问。程序没跑完时，回执列出已经做完的调用和停下时还没落定的调用。',
  '程序在隔离里跑，没有文件系统、网络和子进程，事情一律经能力模块做。每个能力模块都有一份代码模版，拿不准怎么组合时先用 `velar:program` 的 template 读它。',
]

/**
 * 给模型看的门的说明：规矩、随时可用的 `velar:program`、常驻模块的完整声明、其余模块的索引。空间一定，这段文字就一定。
 * 代码模版不在这里：它们不常驻，模型要看时在程序里读。
 */
export function describeGate(modules: readonly MountedCapabilityModule[]): string {
  const resident = modules.filter((module) => module.resident)
  const indexed = modules.filter((module) => !module.resident)
  const parts = [GateRules.map((rule) => `- ${rule}`).join('\n'), ['随时可用的模块：', ProgramModuleDeclarations].join('\n\n')]
  if (!isEmpty(resident)) {
    parts.push(['常驻模块，完整声明如下：', ...resident.map(({ surface }) => surface.declarations.trim())].join('\n\n'))
  }
  if (!isEmpty(indexed)) {
    parts.push([
      '按需导入的模块（这里只列方法名）：',
      ...indexed.map(({ surface }) => `- ${surface.specifier}：${surface.methods.join('、')}`),
      '头一次 import 其中一个时程序不执行，回它的完整声明，照着写再交一次；之后这个会话里一直可以用。',
      'import 可以带租约：`with { lease: \'once\' }` 查一下就完，`\'task\'` 接下来一直要用，`\'done\'` 用完了。',
    ].join('\n'))
  }
  return parts.join('\n\n')
}

/** 程序 import 了还没给过声明的模块：这一次不执行，把它们的完整声明交出去；不认识的名字说清楚有哪些。 */
export function describeNeededModules(needed: readonly MountedCapabilityModule[], unknown: readonly string[], modules: readonly MountedCapabilityModule[]): string {
  const lines = ['程序 import 了还没给过声明的模块，这一次没有执行。']
  if (!isEmpty(unknown)) {
    lines.push(`这个空间里没有 ${unknown.map((name) => `velar:${name}`).join('、')}；有的是 ${modules.map(({ surface }) => surface.specifier).join('、')}。`)
  }
  if (!isEmpty(needed)) {
    lines.push('下面是它们的完整声明，照着把程序写对再交一次（可以用 edits 在刚才那份上改）：', ...needed.map(({ surface }) => surface.declarations.trim()))
  }
  return lines.join('\n\n')
}

/** 这一次授给检查器的声明：常驻的，加上这个会话导入过的。 */
export function grantedModules(modules: readonly MountedCapabilityModule[], imported: ReadonlySet<string>): GrantedModule[] {
  return modules
    .filter((module) => module.resident || imported.has(module.surface.namespace))
    .map(({ surface }) => ({ namespace: surface.namespace, declarations: surface.declarations }))
}

/** 一个导出的值写成给模型读的文字：字符串原样（多行照原样），别的按 JSON。 */
function exportedText(value: unknown): string {
  if (isString(value)) return value
  return JSON.stringify(value) ?? String(value)
}

/** 执行账写成一行：`files.read ×23、shell.run（失败）`。 */
function journalLine(calls: readonly CompletedCall[]): string {
  return calls.map(({ call, ok, times }) => `${call}${isUndefined(times) ? '' : ` ×${times}`}${ok ? '' : '（失败）'}`).join('、')
}

/**
 * 程序跑完（或没跑完）的回执，写成给模型读的文字：导出的值在前（字符串原样、别的按 JSON，具名导出按名字分段），
 * 然后是日志、系统插手过的地方、已经做完与停下时还没落定的调用；没跑完时第一行说为什么。
 * 只有一个导出的值、别的什么都没有时，就只交那个值，不加段头。
 */
export function renderProgramResult(result: CodeProgramResult): string {
  const sections: Array<{ title: string; body: string }> = []
  if (result.named && isPlainObject(result.value)) {
    for (const [name, value] of Object.entries(result.value)) {
      sections.push({ title: name === 'default' ? 'export default' : `export ${name}`, body: exportedText(value) })
    }
  } else if (!isUndefined(result.value)) {
    sections.push({ title: 'export default', body: exportedText(result.value) })
  }
  if (result.logs && !isEmpty(result.logs)) sections.push({ title: 'console.log', body: result.logs.join('\n') })
  if (result.notices && !isEmpty(result.notices)) {
    sections.push({ title: '系统插手过的地方', body: result.notices.map((notice) => `- ${notice.call}${notice.field ? `.${notice.field}` : ''}：${notice.detail}`).join('\n') })
  }
  if (result.completed && !isEmpty(result.completed)) sections.push({ title: '已经做完的调用', body: journalLine(result.completed) })
  if (result.unsettled && !isEmpty(result.unsettled)) {
    sections.push({ title: '停下时还没落定的调用（已经要求它们停下，副作用可能做了一半）', body: result.unsettled.join('、') })
  }

  const lines: string[] = []
  if (result.failed) {
    const where = isUndefined(result.failed.line) ? '' : `，第 ${result.failed.line} 行`
    lines.push(`程序没跑完（${result.failed.code}${where}）：${result.failed.message}`)
  }
  const [only] = sections
  if (sections.length === 1 && only?.title === 'export default' && !result.failed) lines.push(only.body)
  else for (const section of sections) lines.push(`── ${section.title} ──`, section.body)
  if (isEmpty(lines)) lines.push('程序跑完了，没有导出任何东西，也没有打日志。')
  const text = lines.join('\n')
  // 各通道都按预算裁过；段头是这里加的，最后再守一道总上限。
  return text.length <= CodeSurfaceLimits.resultChars ? text : keepTail(text, CodeSurfaceLimits.resultChars).text
}

/** 工具入参换成会话要的程序请求：program 就是 source，edits 与 blobs 原样带过去。 */
export function programRequestOf(input: RunProgramInput): CodeProgramRequest {
  const request: CodeProgramRequest = {}
  if (!isUndefined(input.program)) request.source = input.program
  if (!isUndefined(input.edits)) request.edits = input.edits
  if (!isUndefined(input.blobs)) request.blobs = input.blobs
  return request
}

/**
 * 门的回执写成工具结果：文字在前，每张图前面一行说明；result 就是这些文字按换行拼起来，
 * agent 认出两边一致就把 modelContent 原样交给模型（不转义、不截断）。模型不收图时图不放进去，只说一声。
 */
export function programToolResult(reply: CodeGateReply, acceptsImages: boolean): ProgramToolResult {
  const images = acceptsImages ? reply.images : []
  const dropped = reply.images.length - images.length
  const text = dropped > 0 ? `${reply.text}\n（程序交出了 ${dropped} 张图；当前模型不收图，没有放进来。）` : reply.text
  const parts: ProgramModelContentPart[] = [{ type: 'text', text: text.trim() }]
  for (const image of images) {
    // 说明是空白的图也要有一行：agent 会丢掉空白的文字块，两边就对不上了。
    parts.push({ type: 'text', text: isBlank(image.label) ? '程序交出的图' : image.label.trim() })
    parts.push({ type: 'image-data', data: image.data, mediaType: image.mediaType })
  }
  const result = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n').trim()
  return { result, modelContent: parts }
}
