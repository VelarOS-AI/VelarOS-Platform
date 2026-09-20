import type { FoundationRunEvent } from '@velaros-ai/agent'
import type { ContextRuntime, ContextViewApi } from '@velaros-ai/context'
import type { ModuleDescription, ModulePage, ModuleQuery } from '@velaros-ai/kernel'
import type { CodeProgramRequest, CodeSurfaceOutcome } from '@velaros-ai/script'

import type { ObservationRegistration, ScriptControlOptions, ScriptControlReceipt,ScriptObservationEdit, ScriptReferenceProgram } from '../contract/runtime.js'

/** 一次脚本提交；至少包含观察更新或本轮执行。 */
type ScriptSubmissionFields = {
  /** 更新持续观察代码；省略时继续使用当前版本。 */
  readonly observe?:CodeProgramRequest | ScriptReferenceProgram | ScriptObservationEdit
  /** 本轮只运行一次的代码及其结果可见租约。 */
  readonly execute?:(CodeProgramRequest | ScriptReferenceProgram) & {readonly retainTurns?:number}
}

/** 同一提交至少指定 observe 或 execute；运行时使用同源 schema 校验。 */
export type ScriptSubmission = ScriptSubmissionFields & ({readonly observe:NonNullable<ScriptSubmissionFields['observe']>} | {readonly execute:NonNullable<ScriptSubmissionFields['execute']>})

/** 持久化的提交回执；prepared 表示执行已占位，重试必须核对。 */
export interface ScriptSubmissionReceipt {
  /** 提交的持久阶段，completed 不代替领域执行结果。 */
  readonly status:'prepared'|'completed'|'rejected'
  /** 本次提交是否已进入一次性执行。 */
  readonly executed:boolean
  /** 稳定观察版本的发布或检查回执。 */
  readonly observe?:ScriptControlReceipt
  /** 一次性代码的检查或真实运行回执。 */
  readonly execute?:ScriptControlReceipt | ScriptExecutionReceipt
}

/** 一份由共享主干装配好的运行时。 */
export interface VelarosRuntime {
  /** 打开或恢复持久会话，同一实例内相同 id 复用句柄。 */
  openSession(id: string): Promise<VelarosSession>
  /** 查询实际挂载的模块目录。 */
  modules(query?: ModuleQuery): ModulePage
  /** 查看真实契约，脚本声明与校验同源。 */
  describe(moduleId: string): ModuleDescription
  /** 取消运行，释放模块和存储；重复关闭安全。 */
  close(): Promise<void>
}

/** 一个会话只有一个上下文和一条活动脚本。 */
export interface VelarosSession {
  /** 双核任务检查点与视图，仅宿主可访问完整控制面。 */
  readonly view: ContextViewApi
  /** 会话的稳定身份。 */
  readonly id: string
  /** 宿主记录输入、读取原文和投影下一次请求的入口。 */
  readonly context: ContextRuntime
  /** 由共享 Agent 循环处理用户输入、脚本与上下文维护。 */
  submit(text: string, signal?: AbortSignal): AsyncIterable<FoundationRunEvent>
  /** 统一提交观察更新和本轮执行；先检查全部代码，再发布并执行。 */
  script(input:ScriptSubmission, signal?:AbortSignal, options?:ScriptControlOptions):Promise<ScriptSubmissionReceipt>
  /** 宿主观察便捷调用，转交 script({observe}) 并将拒绝回执转成错误。 */
  observe(program:CodeProgramRequest | ScriptReferenceProgram, signal?:AbortSignal, options?:ScriptControlOptions):Promise<ObservationRegistration>
  /** 宿主执行便捷调用，转交 script({execute}) 并将拒绝回执转成错误。 */
  execute(program:CodeProgramRequest | ScriptReferenceProgram, turns?:number, signal?:AbortSignal, options?:ScriptControlOptions):Promise<ScriptExecutionReceipt>
  /** 由宿主调用领域核对器恢复中断任务；不会重新运行脚本。 */
  reconcile(signal?: AbortSignal): Promise<void>
  /** 取消在途程序并释放会话绑定。 */
  close(): Promise<void>
}

/** 一次性执行沿用原检查及执行结果，并公开实际源码与执行回执身份。 */
export type ScriptExecutionReceipt = CodeSurfaceOutcome & {
  /** 本次真实运行的不可变源码引用。 */
  readonly sourceRef:string
  /** 派生来源。 */
  readonly parentRef?:string
  /** 原 Kernel 使用的实际执行身份。 */
  readonly executionId:string
  /** 当前会话里的完整执行回执。 */
  readonly resultRef:string
}
