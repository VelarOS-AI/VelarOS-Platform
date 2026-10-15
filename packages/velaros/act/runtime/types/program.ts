import type { CodeProgramRequest } from '@velaros-ai/script'

import type { ScriptControlReceipt, ScriptProgramVersion } from './runtime.js'
import type { ScriptSubmission } from './session.js'

/** 完整响应内已经绑定原文与参数的程序提交。 */
export interface ScriptProtocolSubmission {
  /** 稳定观察更新或显式清除。 */
  readonly observe?: LooseOptional<ScriptSubmission['observe']>
  /** 按原文出现顺序执行的程序。 */
  readonly executions: ReadonlyArray<{
    readonly program: NonNullable<ScriptSubmission['execute']>
    /** 省略使用有界返回；true 立即后台，false 优先完整等待，新输入或并行工作进展可提前返回作业身份。 */
    readonly async?: boolean
    /** 仅共用编译器验证结构化控制后签发，不能由程序载荷设置。 */
    readonly control?: true | 'wait'
  }>
}

/** 检查后的候选程序，发布前不改变持久会话状态。 */
export interface PreparedScript {
  /** 需要保存的完整候选代码。 */
  readonly program?: CodeProgramRequest
  /** 对应不可变源码版本的谱系。 */
  readonly version?: ScriptProgramVersion
  /** 候选检查回执。 */
  readonly receipt: ScriptControlReceipt
}

/** 传输解码后的原文声明；语义编译对文本与 JSON 完全共用。 */
export interface ScriptProtocolRecord {
  readonly kind: 'blobs' | 'observe' | 'execute'
  readonly args: readonly unknown[]
  body: string
  readonly line?: number
}
