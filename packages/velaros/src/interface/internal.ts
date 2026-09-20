import type { FoundationRunLimits } from '@velaros-ai/agent'
import type { ContextInvocationJournalApi, ContextStorage, ContextViewApi } from '@velaros-ai/context'
import type { ContextContent, ContextRef, ModelView } from '@velaros-ai/context'
import type { InvocationJournal, ModelImage,OperationModuleDefinition, OperationRuntimeApi } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'
import type { ModelResponseFormat } from '@velaros-ai/model'
import type { CodeProgramRequest, CodeRunnerApi } from '@velaros-ai/script'

import type { ProgramLeaseState, ScriptControlIdentity,ScriptControlReceipt, ScriptProgramVersion } from '../contract/runtime.js'

import type { ScriptSubmission, ScriptSubmissionReceipt } from './provides.js'
import type { VelarosContextOptions } from './requires.js'

/** 标准模块持有的源码与结果访问端口。 */
export interface SessionProgramAccess {
  /** 读取完整脚本底稿的一个分页，不执行或修改代码。 */
  readProgram(ref:string, offset?:number, limit?:number):Promise<ContextContent>
  /** 召回当前会话内已经过期或仍有效的执行结果。 */
  readResult(ref:string, offset?:number, limit?:number):Promise<ContextContent>
  /** 从下一业务回合起重设租约，不执行原程序。 */
  retainResult(ref:string, turns:number, signal:AbortSignal):Promise<unknown>
}

/** 标准模块的受控依赖。 */
export interface StandardModuleHost {
  /** 解析当前任务的观察与材料控制面。 */
  view(sessionId: string): ContextViewApi
  /** 统一模块运行时，构建阶段通过此方法延迟取用。 */
  kernel(): OperationRuntimeApi
  /** 与上下文共用对象存储的持久日志。 */
  readonly journal: InvocationJournal
  /** 读取当前会话的源码与结果访问端口。 */
  programs(sessionId:string):SessionProgramAccess
}

/** 标准操作定义的唯一装配器。 */
export interface StandardModuleFactory {
  /** 模型完整回合的响应契约。 */
  readonly response:ModelResponseFormat
  /** 使用同一 JSON Schema 校验并固定脚本提交参数。 */
  parseScript(input:unknown):ScriptSubmission
  /** 校验模型回合并分离用户消息和一次脚本提交。 */
  parseTurn(value:unknown):{message:string;submission?:ScriptSubmission}
  /** 生成标准模块定义；处理器只转发到主干机制。 */
  create(host: StandardModuleHost): readonly OperationModuleDefinition[]
}

/** 会话由运行时注入的共享实例。 */
export interface VelarosSessionDependencies {
  /** 统一调用日志，可按本步查询真实效果。 */
  readonly journal: ContextInvocationJournalApi
  /** 上下文来源与验收的宿主配置。 */
  readonly contextOptions?: VelarosContextOptions
  /** 注册本会话的源码与结果访问端口，装配层负责生命周期。 */
  register(access:SessionProgramAccess):void
  /** 可选的共享模型驱动。 */
  readonly model?: ModelDriver
  /** 本会话的运行预算。 */
  readonly limits: FoundationRunLimits
  /** 唯一 Kernel 实例。 */
  readonly kernel: OperationRuntimeApi
  /** 显式隔离运行器。 */
  readonly runner: CodeRunnerApi
  /** 可靠存储连接。 */
  readonly storage: ContextStorage
}

/** 与 ContextStorage 共用记录的脚本上下文及可见租约。 */
export interface ProgramContextApi {
  /** 读取已保存的观察代码引用与租约计数。 */
  state():Promise<ProgramLeaseState>
  /** 当前源码的不可变谱系，旧版源码可以没有谱系记录。 */
  version(ref:string):Promise<ScriptProgramVersion|undefined>
  /** 获取已发布的提交回执；同一身份不同输入拒绝。 */
  receipt(control:ScriptControlIdentity):Promise<ScriptSubmissionReceipt|undefined>
  /** 原子发布本次全部源码、观察版本和执行占位，返回是否由本调用占位。 */
  publish(prepared:readonly PreparedScript[],control:ScriptControlIdentity,receipt:ScriptSubmissionReceipt,activate:boolean,visible:boolean,signal:AbortSignal):Promise<{receipt:ScriptSubmissionReceipt;claimed:boolean}>
  /** 将已占位的一次执行记录为完成；回执丢失时占位仍禁止自动重跑。 */
  finish(control:ScriptControlIdentity,receipt:ScriptSubmissionReceipt):Promise<ScriptSubmissionReceipt>
  /** 追加一次执行结果的可见租约。 */
  add(ref:ContextRef, source:ContextRef, executionId:string, turns:number):Promise<void>
  /** 按当前会话读取不可变的完整脚本底稿。 */
  readProgram(ref:string,offset?:number,limit?:number):Promise<ContextContent>
  /** 明确读取原始结果，读取本身不延长自动展示。 */
  read(ref:string, offset?:number, limit?:number):Promise<ContextContent>
  /** 有限重设租期。 */
  retain(ref:string, turns:number, signal?:AbortSignal):Promise<unknown>
  /** 装配观察结果、有效租约、最小事实；原始事实仍由现有视图管理。 */
  project(view:ModelView, observation:ContextRef|undefined, images:readonly ModelImage[], signal:AbortSignal, maxChars?:number):Promise<{body:string;images:readonly ModelImage[]}>
  /** 成功业务回合扣减一次，同一帧幂等。 */
  consume(frameId:string, signal:AbortSignal):Promise<void>
}

/** 检查后的候选程序，发布前不改变持久会话状态。 */
export interface PreparedScript {
  /** 需要保存的完整候选代码。 */
  readonly program?:CodeProgramRequest
  /** 对应不可变源码版本的谱系。 */
  readonly version?:ScriptProgramVersion
  /** 候选检查回执。 */
  readonly receipt:ScriptControlReceipt
}
