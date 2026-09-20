import type { InvocationReceipt, InvocationReconciliation, InvocationRecord, PreparedInvocation } from '@velaros-ai/kernel/contracts'

import type { ContextAppend, ContextContent, ContextProjection, ContextQuery, ContextReadRange, ContextRecord, ContextRef, ContextSearchPage, ContextSnapshot, NoteWrite, WorkingSetChange, WorkingSetCommit } from '../contract/context.js'
import type { ContextFeedback, ContextSourceCard, ContextStepRecord, ContextTaskState, ContextTaskStatus, ContextViewLimits,ModelView, RegisteredViewIntent, TaskCapsule, ViewIntentInput } from '../contract/context.js'

import type { ContextBuildOptions, ContextCompletionPort } from './requires.js'
/** 用上下文对象存储兑现 Kernel 的持久化调用契约。 */
export interface ContextInvocationJournalApi {
  /** 持久保存领域核对结论，原始意图与回执不可覆盖。 */
  recordReconciliation(sessionId: string, id: string, result: InvocationReconciliation): Promise<void>
  /** 原子占用调用号，跨连接只会有一个派发者。 */
  claim(prepared: PreparedInvocation): Promise<InvocationRecord | null>
  /** 原子记录唯一准备结果，调用处理器之前必须完成。 */
  prepare(prepared: PreparedInvocation): Promise<void>
  /** 保存终态回执，IO 失败保持待核对的意图。 */
  settle(receipt: InvocationReceipt): Promise<void>
  /** 读取原始意图和已有终态。 */
  read(sessionId: string, id: string): Promise<InvocationRecord | null>
  /** 查询同会话的派发记录，供效果屏障和崩溃恢复使用。 */
  list(sessionId: string, executionId?: string): Promise<readonly InvocationRecord[]>
}
/** 会话的上下文权威。 */
export interface ContextRuntime {
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
  inspect(): Promise<ContextTaskState | null>
  /** 追加用户目标并取得一个有限租约，返回租约身份。 */
  begin(goal: ContextRef, signal?: AbortSignal): Promise<string>
  /** 只有持有当前租约的运行可以开始下一步。 */
  startStep(executionId: string, signal?: AbortSignal): Promise<void>
  /** 通过当前执行登记下一轮观察需求。 */
  request(intent: ViewIntentInput, signal?: AbortSignal): Promise<RegisteredViewIntent>
  /** 模型只更新非事实性任务胶囊。 */
  updateCapsule(capsule: Partial<TaskCapsule>, signal?: AbortSignal): Promise<TaskCapsule>
  /** 保存中间材料到同一不可变对象存储，返回受会话范围保护的引用。 */
  putArtifact(body: string, sources?: readonly ContextRef[], signal?: AbortSignal): Promise<ContextRef>
  /** 按范围读取当前任务登记的材料。 */
  readArtifact(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent>
  /** 记录真实执行效果后进入物化屏障，取消终态不会被复活。 */
  settle(feedback: readonly ContextFeedback[], signal?: AbortSignal, step?: ContextStepRecord): Promise<void>
  /** 精确解析或有界规划后发布当前证据；重做本阶段不执行世界操作。 */
  build(options: ContextBuildOptions, signal?: AbortSignal): Promise<ModelView>
  /** 发送前复核任务、范围和资源版本。 */
  validate(view: ModelView, signal?: AbortSignal): Promise<boolean>
  /** 世界写入前核对当前执行身份、未决效果与先前证据。 */
  assertCanWrite(executionId: string, signal?: AbortSignal): Promise<void>
  /** 为两个模型预占调用与 token 预算。 */
  reserveModel(role: 'main' | 'context', tokens: number): Promise<void>
  /** 保存供应商实际用量；缺少用量时保持未知计数。 */
  recordUsage(inputTokens: number, outputTokens: number): Promise<void>
  /** 依照未决效果、证据缺口、新鲜度和领域验收器判断交付。 */
  complete(verifier?: ContextCompletionPort, signal?: AbortSignal): Promise<{ readonly completed: boolean; readonly verified: boolean; readonly reason: string }>
  /** 宿主将日志恢复或核对事实合入检查点；不复活取消终态。 */
  recover(feedback: readonly ContextFeedback[]): Promise<void>
  /** 宿主保存结束或暂停阶段，撤销当前租约。 */
  end(status?: ContextTaskStatus): Promise<void>
}
