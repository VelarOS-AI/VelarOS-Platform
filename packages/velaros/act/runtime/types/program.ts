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
    readonly async: boolean
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
