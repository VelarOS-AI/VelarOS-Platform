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
  const name = (kind: 'blobs' | 'observe' | 'execute' | 'done') => nativeToolName(kind, config)
  const hasProgram = allowed.includes('execute') || allowed.includes('observe')
  return [
    '使用已提供的原生工具，参数是符合工具 Schema 的 JSON 对象。同一响应可提交多个独立工具调用，各自拥有调用身份和回执；实际执行次序由 Runtime 调度。',
    hasProgram
      ? '程序源码放 code，程序选项放 options。code 按 JSON 字符串编码，解码后的值作为 JavaScript 源码执行；引号、换行和反斜线按 JSON 规则转义。options.input 与 options.inputRef:"host:名称" 互斥；通过 import {input} from "velaros:program" 读取参数。其他字段包括 options.modules、options.blobs:{名称:额外原文}。'
      : '',
    hasProgram
      ? 'options.sourceRef 复用归档源码，options.edits:[{oldText,newText,module?}] 精确编辑；引用或编辑时 code 为 ""。options.format:"program" 时 code 是序列化后的完整程序 JSON，程序字段在该对象内提供。示例中的原文、源码片段和引用应换成本轮实际值。'
      : '',
    allowed.includes('execute')
      ? `${name('execute')} 执行一次 code；options.async:true 后台受理。options.retain:1..32 控制结果曝光次数，"segment" 随历史封段退役，"task" 保留至任务结束；默认 ${defaultRetain}。`
      : '',
    allowed.includes('observe')
      ? `${name('observe')} 的 code 提供完整只读源码时登记或整体替换当前观察，所需程序参数通过 options 提供。观察采用自己的 Schema，刷新、编辑和退订都调用这个工具。`
      : '',
    allowed.includes('observe')
      ? `${name('observe')} 退订参数：${JSON.stringify({ code: '', options: { clear: true } })}；clear 使用这一独立参数组合。`
      : '',
    allowed.includes('observe')
      ? `${name('observe')} 局部修改参数：${JSON.stringify({ code: '', options: { edits: [{ oldText: '原文片段', newText: '替换片段' }] } })}；省略 options.sourceRef 时以当前观察为底稿。`
      : '',
    allowed.includes('observe')
      ? `${name('observe')} 强制刷新参数：${JSON.stringify({ code: '', options: { sourceRef: '当前观察引用', refresh: true } })}。固定快照使用空 code 和 options.snapshot:{provider,plan,input}，值从已授权目录及领域合同取得。`
      : '',
    allowed.includes('blobs')
      ? `${name('blobs')} 用 name/text 绑定原文，参数示例：${JSON.stringify({ name: 'content', text: '需保留的原文' })}。text 使用 JSON 字符串编码，解码后逐字绑定。`
      : '',
    allowed.includes('blobs') && hasProgram
      ? `同一响应可同时调用 ${name('blobs')} 与 ${allowed.includes('execute') ? name('execute') : name('observe')}；程序通过 import {blobs} from "velaros:program" 读取，例如 blobs.content。`
      : '',
    allowed.includes('done')
      ? `${name('done')} 通过 message 给出用户答复，通过 completion 给出完成依据；参数示例：${JSON.stringify({ message: '基于实际结果的答复', completion: '已经核实的完成依据' })}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
