import type { InvocationReceipt, InvocationReconciliation, InvocationRecord, PreparedInvocation } from '@velaros-ai/kernel/contracts'

import type { TurnContextDelta,TurnContextLedgerAppendInput,TurnContextLedgerPeekResult,TurnContextSourcePeekInput } from '../contract/activity.js'
import type { ContextReadStamp,ContextSourceHit,ContextSourceRead,ContextTarget,ContextTaskScope,ContextTime,ContextViewForm } from '../contract/context.js'
import type { ContextAppend, ContextContent, ContextInputSummary, ContextProjection, ContextQuery, ContextReadRange, ContextRecord, ContextRef, ContextSearchPage, ContextSnapshot, ContextUserInput, NoteWrite, WorkingSetChange, WorkingSetCommit } from '../contract/context.js'
import type { ContextCompletionResult, ContextFeedback, ContextSourceCard, ContextStepRecord, ContextTaskState, ContextTaskStatus, ContextViewLimits,ModelView, RegisteredViewIntent, TaskCapsule, ViewIntentInput } from '../contract/context.js'

import type { TurnContextAppendListener } from './requires.js'
import type { ContextBuildOptions, ContextCompletionPort } from './requires.js'
/** 用上下文对象存储兑现 Kernel 的持久化调用契约。 */
export interface ContextInvocationJournalApi {
  /** 持久保存领域核对结论，原始意图与回执不可覆盖。 */
  recordReconciliation(sessionId: string, id: string, result: InvocationReconciliation): Promise<void>
  /** 原子占用调用号，跨连接只会有一个派发者。 */
  claim(prepared: PreparedInvocation): Promise<Nullable<InvocationRecord>>
  /** 原子记录唯一准备结果，调用处理器之前必须完成。 */
  prepare(prepared: PreparedInvocation): Promise<void>
  /** 保存终态回执，IO 失败保持待核对的意图。 */
  settle(receipt: InvocationReceipt): Promise<void>
  /** 读取原始意图和已有终态。 */
  read(sessionId: string, id: string): Promise<Nullable<InvocationRecord>>
  /** 查询同会话的派发记录，供效果屏障和崩溃恢复使用。 */
  list(sessionId: string, executionId?: string): Promise<readonly InvocationRecord[]>
}
/** 会话的上下文权威。 */
export interface ContextRuntime {
  /** 保存原始用户输入，超大文本分块归档，附件保留引用。 */
  ingest(input:ContextUserInput,signal?:AbortSignal):Promise<ContextRecord>
  /** 分页读取原始用户输入；不会读入同会话的其他审计记录。 */
  readInput(ref:ContextRef,range?:ContextReadRange):Promise<ContextContent>
  /** 按版本保存理解结果，原文始终保留，摘要是模型解释。 */
  summarizeInput(input:ContextInputSummary,signal?:AbortSignal):Promise<ContextRef>
  /** 为真实目标生成有界正文或摘要，保留可召回元数据。 */
  projectInput(ref:ContextRef,maxChars:number):Promise<ContextContent>

  /** 查看当前工作集和始终保留的最新用户输入。 */
  inspect(): Promise<ContextSnapshot>
  /** 检索当前会话的材料与原始记录。 */
  search(query: ContextQuery): Promise<ContextSearchPage>
  /** 有界读取原始正文，来源元数据不能被笔记改写。 */
  read(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent>
  /** 模型写入带来源的工作材料。 */
  write(note: NoteWrite, signal?: AbortSignal): Promise<ContextRecord>
  /** 原子替换模型管理区；新事件总是保留。 */
  replace(change: WorkingSetChange, signal?: AbortSignal): Promise<WorkingSetCommit>
  /** 宿主追加原始事件，模型标准库不暴露此方法。 */
  append(input: ContextAppend, signal?: AbortSignal): Promise<ContextRecord>
  /** 冻结下一次请求的材料；超预算明确失败，不隐式压缩。 */
  project(maxChars: number): Promise<ContextProjection>
  /** 构建明确有界的恢复视图；原始正文通过引用分页读取。 */
  recover(maxChars: number): Promise<ContextProjection>
}

/** 绑定会话的双核任务与证据视图，不另持有工具、模型或数据库。 */
export interface ContextViewApi {
  /** 列出已装配的证据源与其真实一致性能力。 */
  sources(): readonly ContextSourceCard[]
  /** 生效预算供共享模型网关使用。 */
  readonly limits: ContextViewLimits
  /** 读取持久检查点，包含真实阶段和用量。 */
  inspect(): Promise<Nullable<ContextTaskState>>
  /** 追加用户目标并取得一个有限租约，返回租约身份。 */
  begin(goal: ContextRef, signal?: AbortSignal, mode?:'continue'|'new'): Promise<string>
  /** 活动运行接收已归档的用户补充，保留总预算并使旧视图失效。 */
  appendGoal(goal:ContextRef,signal?:AbortSignal):Promise<void>
  /** 只有持有当前租约的运行可以开始下一步。 */
  startStep(executionId: string, signal?: AbortSignal, concurrent?:boolean, basis?:LooseOptional<ModelView>): Promise<void>
  /** 通过当前执行登记下一轮观察需求。 */
  request(intent: ViewIntentInput, signal?: AbortSignal, executionId?:string): Promise<RegisteredViewIntent>
  /** 模型只更新非事实性任务胶囊。 */
  updateCapsule(capsule: Partial<TaskCapsule>, signal?: AbortSignal, executionId?:string): Promise<TaskCapsule>
  /** 保存中间材料到同一不可变对象存储，返回受会话范围保护的引用。 */
  putArtifact(body: string, sources?: readonly ContextRef[], signal?: AbortSignal, executionId?:string): Promise<ContextRef>
  /** 按范围读取当前任务登记的材料。 */
  readArtifact(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent>
  /** 记录真实执行效果后进入物化屏障，取消终态不会被复活。 */
  settle(feedback: readonly ContextFeedback[], signal?: AbortSignal, step?: ContextStepRecord): Promise<void>
  /** 在同一存储上只读组装候选，不发布视图也不要求执行租约。 */
  preview(options:ContextBuildOptions,signal?:AbortSignal):Promise<ModelView>
  /** 精确解析或有界规划后发布当前证据；重做本阶段不执行世界操作。 */
  build(options: ContextBuildOptions, signal?: AbortSignal): Promise<ModelView>
  /** 发送前复核任务、范围和资源版本。 */
  validate(view: ModelView, signal?: AbortSignal): Promise<boolean>
  /** 世界写入前核对当前执行身份、未决效果与先前证据。 */
  assertCanWrite(executionId: string, signal?: AbortSignal): Promise<void>
  /** 在模型或后台任务等待时续期当前所有权，失去所有权则失败。 */
  renew(signal?:AbortSignal):Promise<void>
  /** 为两个模型预占调用与 token 预算。 */
  reserveModel(role: 'main' | 'context', tokens: number): Promise<void>
  /** 释放未实际发出的预留模型调用。 */
  releaseModel(role:'main'|'context',tokens:number):Promise<void>
  /** 保存供应商实际用量；缺少用量时保持未知计数。 */
  recordUsage(inputTokens: number, outputTokens: number): Promise<void>
  /** 依照未决效果、证据缺口、新鲜度和领域验收器判断交付。 */
  complete(verifier?: ContextCompletionPort, signal?: AbortSignal): Promise<ContextCompletionResult>
  /** 宿主将日志恢复或核对事实合入检查点；不复活取消终态。 */
  recover(feedback: readonly ContextFeedback[]): Promise<void>
  /** 宿主保存结束或暂停阶段，撤销当前租约。 */
  end(status?: ContextTaskStatus): Promise<void>
}

/** 共用的真实来源访问器，不接收模型编造的正文。 */
export interface EvidenceAccessApi {
  /** 返回宿主装配源的真实目录。 */
  sources():readonly ContextSourceCard[]
  /** 检索并逐项授权返回候选。 */
  search(scope:ContextTaskScope,sourceId:string,query:string,limit:number,signal:AbortSignal):Promise<readonly ContextSourceHit[]>
  /** 校验指定来源的当前访问范围。 */
  authorize(scope:ContextTaskScope,target:ContextTarget,signal:AbortSignal):Promise<void>
  /** 真实读取、校验版本身份与内容指纹。 */
  read(scope:ContextTaskScope,target:ContextTarget,form:ContextViewForm,time:ContextTime,maxBytes:number,signal:AbortSignal):Promise<ContextSourceRead>
  /** 重验已保存证据的版本和权限。 */
  validate(scope:ContextTaskScope,stamp:ContextReadStamp,signal:AbortSignal):Promise<'current'|'changed'|'unknown'>
}

/** 会话活动记录的唯一访问接口。 */
export interface TurnContextSessionLedgersApi {
  /** 往这个会话的账本记一条 delta（没有就先建一本），并广播一次变更通知。返回落好的 delta。 */
  append(sessionId: string, input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 状态型 source 的写入口：清空这个会话的账本只留这一条，同样广播变更——界面上的状态提示要立刻换成新的，而不是等下一次事件。 */
  replaceLatest(sessionId: string, input: TurnContextLedgerAppendInput): TurnContextDelta
  /** 读这个会话还没被消费的 delta。这个会话还没有账本时交出一份空基底（generation 为进程代次、headSeq 1、tailSeq 0），不会为一次只读 peek 建账本。 */
  peek(sessionId: string, input: Pick<TurnContextSourcePeekInput, 'afterSeq' | 'generation'>): TurnContextLedgerPeekResult
  /** 丢掉这个会话的账本；会话关闭或重置时调。下次再写会建一本新的、带新代次的。 */
  clearSession(sessionId: string): void
}


/** 会话活动记录的唯一访问接口。 */
export interface TurnContextAppendHubApi {
  /** 订阅任意 source 的 delta 写入通知；订阅时不补发历史，返回的函数用来退订。 */
  subscribe(listener: TurnContextAppendListener): () => void
  /** 广播一次「某会话的某个 source 刚写入」的通知；逐个监听器隔离异常，监听器抛错不影响其余监听器，也不回传给账本。 */
  emit(sessionId: string, sourceId: string): void
}
