import { isFalse } from '@velaros-ai/core'

import { ObservationLimits } from '../contract/constants.js'
import type { ScriptProtocolOptions } from '../types/runtime.js'

import { protocolConfig } from './script-protocol.js'

/** 保留 exec 的原生入口名，其余声明遵循宿主命名。 */
export function nativeToolName(
  kind: 'blobs' | 'observe' | 'execute' | 'done',
  options: ScriptProtocolOptions
): string {
  return options.names?.[kind] === 'execute' && kind === 'execute'
    ? 'exec'
    : (options.names?.[kind] ?? (kind === 'execute' ? 'exec' : kind))
}

/** 原生传输的固定用法：按工具名称与 JSON 参数描述，示例随当前许可裁剪。 */
export function nativeProtocolRules(options: ScriptProtocolOptions): string {
  const config = protocolConfig(options)
  const { allowed, defaultRetain } = config
  const observationPrograms = allowed.includes('observe') && !isFalse(config.observationPrograms)
  const name = (kind: 'blobs' | 'observe' | 'execute' | 'done') => nativeToolName(kind, config)
  const hasProgram = allowed.includes('execute') || observationPrograms
  return [
    '需要操作时使用已提供的原生工具，参数是符合工具 Schema 的 JSON 对象。同一响应可提交多个独立工具调用，各自拥有调用身份和回执；实际执行次序由 Runtime 调度。已有工作仍在运行且当前只需等待时，仅返回普通文本进度，Runtime 挂起模型调用并在执行进展、子任务结果或新输入后恢复。',
    hasProgram
      ? '程序源码放 code，程序选项放 options。code 按 JSON 字符串编码，解码后的值作为 JavaScript 源码执行；引号、换行和反斜线按 JSON 规则转义。options.input 与 options.inputRef:"host:名称" 互斥；通过 import {input} from "velaros:program" 读取参数。其他字段包括 options.modules、options.blobs:{名称:额外原文}。'
      : '',
    hasProgram
      ? `复制或转换已有内容时，先在程序内读取文件或授权来源引用，再由实际读到的值生成输出及校验预期；模型重写的副本只能证明自洽。新写的文档、补丁和源码片段随使用它的程序一次提交到 ${allowed.includes('execute') ? name('execute') : name('observe')} 的 options.blobs，code 写读取和应用逻辑。编辑中的大段或多行 oldText/newText 同样放 options.blobs，通过 blobs.oldText/blobs.newText 引用，不内嵌为字符串、模板字符串或字符串拼接；从文件读取并截取的旧文直接用读取值，短定位文本可内联；反引号、插值标记和反斜线保持原样，只经过工具 JSON 编码。原文示例：${JSON.stringify({ code: 'import {blobs} from "velaros:program"; console.log(blobs.content)', options: { blobs: { content: '新写的内容' } } })}。`
      : '',
    hasProgram
      ? 'options.sourceRef 复用归档源码，options.edits:[{oldText,newText,module?}] 精确编辑；引用或编辑时 code 为 ""。options.format:"program" 时 code 是序列化后的完整程序 JSON，程序字段在该对象内提供。示例中的原文、源码片段和引用应换成本轮实际值。'
      : '',
    allowed.includes('execute')
      ? `${name('execute')} 执行一次 code；省略 options.async 使用短等待返回，options.async:true 立即返回执行身份，options.async:false 优先等待完成，新输入、并行程序收束或子任务进展可提前返回执行身份，原程序继续；options.timeoutMs 指定本次程序计时，源码引用不继承。等待已有作业用空 code 与 options.control:{kind:"wait",executionId,waitMs:60000}，无需循环 read 或运行定时器；waitMs 为 1..60000 的整数，默认 60000，到期返回当前状态。检查/停止用 kind:"read"/"stop"，最多 5000 毫秒；read/wait 可加 cursor/limit。每次只受理一个等待，其通道与检查/停止独立，普通执行槽满时仍可用。options.retain:1..32 控制结果曝光次数，"segment" 随历史封段退役，"task" 保留至任务结束；默认 ${defaultRetain}。`
      : '',
    observationPrograms
      ? `${name('observe')} 用于跨轮需要及时核对的小状态、摘要、差异或引用；code 提供只读源码时登记或整体替换当前观察，下个正常业务轮采集，按需登记而非每轮调用。正文只在当前 dynamic 展示，默认 ${ObservationLimits.defaultChars}、最多 ${ObservationLimits.maxChars} 字符；普通读取、大文件、完整 DOM 和动作结果${allowed.includes('execute') ? `用 ${name('execute')}，按正常结果增量交付` : '不属于观察材料'}。只读采集不支持时如实保留不可用，不得换普通执行冒充观察。`
      : '',
    allowed.includes('observe') && !observationPrograms
      ? `${name('observe')} 当前仅支持局部 history 选择与 clear 退订；只读程序不可用：${config.observationUnavailableReason ?? '宿主未声明只读程序约束支持'}。不要提交源码、刷新、快照或编辑，也不得用普通执行冒充只读采集。`
      : '',
    allowed.includes('observe') && allowed.includes('execute')
      ? `${name('observe')} 与 ${name('execute')} 必须分开响应；混合响应整批退回修复，任何程序均不执行。`
      : '',
    allowed.includes('observe')
      ? `${name('observe')} 退订参数：${JSON.stringify({ code: '', options: { clear: true } })}；clear 使用这一独立参数组合。`
      : '',
    observationPrograms
      ? `${name('observe')} 局部修改参数：${JSON.stringify({ code: '', options: { edits: [{ oldText: '原文片段', newText: '替换片段' }] } })}；省略 options.sourceRef 时以当前观察为底稿。`
      : '',
    observationPrograms
      ? `${name('observe')} 强制刷新参数：${JSON.stringify({ code: '', options: { sourceRef: '当前观察引用', refresh: true } })}。固定快照使用空 code 和 options.snapshot:{provider,plan,input}，值从已授权目录及领域合同取得。`
      : '',
    allowed.includes('observe')
      ? `${name('observe')} 局部历史目录：${JSON.stringify({ code: '', options: { history: { kind: 'list' } } })}，cursor 续页，limit 默认 ${ObservationLimits.defaultList}、最多 ${ObservationLimits.maxList} 项；按返回的 snapshotId 读取：${JSON.stringify({ code: '', options: { history: { kind: 'read', snapshotId: '目录返回的快照身份', pointer: '/result', offset: 0, limit: ObservationLimits.defaultReadChars } } })}，read 默认 ${ObservationLimits.defaultReadChars}、最多 ${ObservationLimits.maxReadChars} 字符。history 独占 options、code 必须为空，不能附带 snapshot、refresh、clear、源码引用或 blobs；只选择下一帧 dynamic，不替换当前持续观察，过后不自动重复注入。核实操作前后或排查变化时，先选旧快照必要片段，再结合当前状态判断；超限时缩小片段，普通大材料走执行结果，不自动补成历史增量。登记或选择回执表示已接纳，实际内容与失败以下一帧为准。`
      : '',
    allowed.includes('blobs')
      ? `${name('blobs')} 用 name/text 绑定原文，参数示例：${JSON.stringify({ name: 'content', text: '需保留的原文' })}。text 使用 JSON 字符串编码，解码后逐字绑定。`
      : '',
    allowed.includes('blobs') && hasProgram
      ? `${name('blobs')} 必须与使用它的 ${allowed.includes('execute') ? name('execute') : name('observe')} 在同一响应同时提交；原文只属于本响应，单独提交会拒绝接纳。程序通过 import {blobs} from "velaros:program" 读取，例如 blobs.content。`
      : '',
    allowed.includes('done')
      ? `${name('done')} 通过 message 给出用户答复，通过 completion 给出完成依据；参数示例：${JSON.stringify({ message: '基于实际结果的答复', completion: '已经核实的完成依据' })}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
