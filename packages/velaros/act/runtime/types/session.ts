import type { CodeProgramRequest, CodeSurfaceOutcome } from '@velaros-ai/script'

import type { ScriptRetention } from './results.js'
import type {
  ScriptControlReceipt,
  ScriptObservationEdit,
  ScriptReferenceProgram,
  ScriptSnapshotObservation,
} from './runtime.js'

/** 交来的一段程序正文；存档路径只属于脚本库，提交里没有。 */
export type ScriptSourceProgram = Omit<CodeProgramRequest, 'path'>

/** 持续观察可在发布时要求下一正常业务轮真实采集。 */
export type ScriptObservationProgram = (
  ScriptSourceProgram | ScriptReferenceProgram | ScriptObservationEdit | ScriptSnapshotObservation
) & { readonly refresh?: boolean }

/** 一次脚本提交；至少包含观察更新或本轮执行。 */
export type ScriptSubmissionFields = {
  /** 更新持续观察代码；省略时继续使用当前版本。 */
  readonly observe?: ScriptObservationProgram
  /** 本轮只运行一次的代码及其结果可见租约。 */
  readonly execute?: (ScriptSourceProgram | ScriptReferenceProgram) & {
    readonly retainTurns?: ScriptRetention
  }
}

/** 同一提交至少指定 observe 或 execute；运行时按这个类型逐项核对（`checkScriptSubmission`）。 */
export type ScriptSubmission = ScriptSubmissionFields &
  (
    | { readonly observe: NonNullable<ScriptSubmissionFields['observe']> }
    | { readonly execute: NonNullable<ScriptSubmissionFields['execute']> }
  )

/** 持久化的提交回执；prepared 表示执行已占位，重试必须核对。 */
export interface ScriptSubmissionReceipt {
  /** 提交的持久阶段，completed 不代替领域执行结果。 */
  readonly status: 'prepared' | 'completed' | 'rejected'
  /** 本次提交是否已进入一次性执行。 */
  readonly executed: boolean
  /** 稳定观察版本的发布或检查回执。 */
  readonly observe?: ScriptControlReceipt
  /** 一次性代码的检查或真实运行回执。 */
  readonly execute?: ScriptControlReceipt | ScriptExecutionReceipt
  /** 同一批次预检及派发的多执行回执，单脚本宿主继续使用 execute。 */
  readonly executions?: ReadonlyArray<ScriptControlReceipt | ScriptExecutionReceipt>
}

/** 一次性执行沿用原检查及执行结果，并公开实际源码与执行回执身份。 */
export type ScriptExecutionReceipt = CodeSurfaceOutcome & {
  /** 本次真实运行的不可变源码引用。 */
  readonly sourceRef: string
  /** 派生来源。 */
  readonly parentRef?: string
  /** 原 Kernel 使用的实际执行身份。 */
  readonly executionId: string
  /** 当前会话里的完整执行回执。 */
  readonly resultRef: string
}
