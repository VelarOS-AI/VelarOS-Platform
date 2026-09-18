/** 门的几段文字：给模型的使用说明（连同常驻模块的声明与其余模块的索引）、要补声明时的回执、程序跑完的回执。都不碰实例状态。 */

import { isBlank, isEmpty, isUndefined } from '@velaros-ai/core'

import type { CodeProgramRequest, CodeProgramResult, GrantedModule, MountedCapabilityModule } from '../types/code-surface.js'
import type { CodeGateReply, ProgramModelContentPart, ProgramToolResult, RunProgramInput } from '../types/gate.js'

/** 怎么写一段交给门的程序：对所有空间都成立的那几条。 */
const GateRules = [
  '交一段 JavaScript ES 模块：import 能力模块（如 `import { read } from \'velar:project\'`），顶层直接 await，export default 交出答案。',
  '只有 export default 的值会回到你这里（console.log 的输出也会带回来）；能力读回来的东西留在程序的变量里——要看什么就交出什么，大的先看大小再决定交多少。',
  '程序先按下面的声明过类型检查再执行：没过就一行都不执行，回带代码帧的诊断；改的时候传 edits（oldText 照框出来的原文一字不差、在程序里唯一，newText 写新的），不用整份重发。',
  '大段文本（文件正文、补丁）放进 blobs，程序里 `import { blobs } from \'velar:program\'` 按名字取，不要写进源码。',
  '能力调用失败在程序里是能 try/catch 的异常，只有 error.code 与 error.message；要用户点头的操作（危险命令、落回、写敏感文件）在那次调用里自己会问。',
  '程序在隔离里跑，没有文件系统、网络和子进程，事情一律经能力模块做。',
]

/** 给模型看的门的说明：规矩、常驻模块的完整声明、其余模块的索引。空间一定，这段文字就一定。 */
export function describeGate(modules: readonly MountedCapabilityModule[]): string {
  const resident = modules.filter((module) => module.resident)
  const indexed = modules.filter((module) => !module.resident)
  const parts = [GateRules.map((rule) => `- ${rule}`).join('\n')]
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

/** 程序跑完（或没跑完）的回执：结果原样写成 JSON，模型照着字段读。 */
export function describeProgramResult(result: CodeProgramResult): string {
  return JSON.stringify(result)
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
