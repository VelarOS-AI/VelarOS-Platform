import { isEmpty,isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolConfirmationDecisionOptions } from '../../types/agent'
import type { ExecutionPendingInteractionKind, ExecutionPendingInteractionSnapshot, ExecutionProvideInputRequest, ExecutionRecord, ExecutionResolveConfirmationRequest } from '../../types/agent.js'
import type { ExecutionInteractions } from '../records/ExecutionInteractions'
import type { ExecutionRecords } from '../records/ExecutionRecords'
import type { ExecutionStore } from '../records/ExecutionStore'
import type { SourceSessionGuard } from '../records/SourceSessionGuard'

/**
 * 「执行在等用户」这一面的聚合入口：工具要确认、要追问时在这里挂起；renderer 只知道 sessionId 时也从这里找回对应的执行。
 *
 * 由 `ExecutionService` 持有一份。按 sourceSession 找执行统一走 active guard 优先、再退回最近一条的顺序，
 * 因此由外部入口发起、宿主后分配 scope 的执行也能被正确找到。
 */
export interface ExecutionInteractionFacadeApi {
  /** 工具需要「用户确认后继续」时在这里挂起：批准才 resolve，拒绝按约定终止执行；中止信号到达即 reject。 */
  awaitConfirmation(executionId: string, message: string, abortSignal?: AbortSignal, options?: ToolConfirmationDecisionOptions): Promise<void>
  /** 同样是等确认，但把批准/拒绝**作为结果返回**而不终止执行——用于「拒绝了也要继续跑」的工具，`message` 带回用户的理由或卡片结果。 */
  awaitConfirmationDecision(executionId: string, message: string, abortSignal?: AbortSignal, options?: ToolConfirmationDecisionOptions): Promise<{ approved: boolean; message: Nullable<string> }>
  /** 需要用户补一段文本时在这里挂起，返回用户答的原文；中止信号到达即 reject。 */
  awaitUserInput(executionId: string, question: string, abortSignal?: AbortSignal): Promise<string>
  /** renderer 对**指定执行**的确认应答；`confirmationId` 用于对上具体那一次确认，过期的卡片不会误唤醒新的等待。 */
  resolveConfirmation(executionId: string, approved: boolean, rejectionMessage?: LooseOptional<string>, confirmationId?: string): ExecutionRecord
  /** renderer 对**指定执行**的追问应答。 */
  provideInput(executionId: string, answer: string): ExecutionRecord
  /** renderer 只有 sessionId 时的追问应答：先找到该会话正在等输入的执行，没有就抛 `NOT_FOUND`。 */
  provideInputForSourceSession(request: ExecutionProvideInputRequest): ExecutionRecord
  /** 该会话此刻是否挂着某一类待处理交互（确认或追问）；UI 据此决定要不要显示等待态。 */
  hasPendingInteractionForSourceSession(sessionId: string, kind: ExecutionPendingInteractionKind): boolean
  /** 该会话是否有正在跑（pending / running）的执行。用 source-aware 查找，不依赖精确 scope key，避免外部入口发起的运行被误判成未运行。 */
  isRunningForSourceSession(sessionId: string): boolean
  /** 取该会话待处理交互的展示快照（确认文案与卡片，或追问问题）；没有待处理的返回 null。 */
  getPendingInteractionForSourceSession(sessionId: string, kind: ExecutionPendingInteractionKind): Nullable<ExecutionPendingInteractionSnapshot>
  /**
   * renderer 只有 sessionId 时的确认应答。会先校验卡片 id 属于当前这组确认（过期卡片一律拒绝，抛 `VALIDATION`），
   * 再把结构化的卡片结果与拒绝理由一起序列化进 decision message——两者并存，不做二选一。
   */
  resolveConfirmationForSourceSession(request: ExecutionResolveConfirmationRequest): ExecutionRecord
}

class ExecutionInteractionFacade implements ExecutionInteractionFacadeApi {
  constructor(
    private readonly interactions: ExecutionInteractions,
    private readonly records: ExecutionRecords,
    private readonly sourceSessionGuard: SourceSessionGuard,
    private readonly store: ExecutionStore
  ) {}

  public async awaitConfirmation(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void> {
    return this.interactions.awaitConfirmation(executionId, message, abortSignal, options)
  }

  public async awaitConfirmationDecision(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<{ approved: boolean; message: Nullable<string> }> {
    return this.interactions.awaitConfirmationDecision(executionId, message, abortSignal, {
      ...options,
      rejectTerminatesExecution: false,
    })
  }

  public async awaitUserInput(
    executionId: string,
    question: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    return this.interactions.awaitUserInput(executionId, question, abortSignal)
  }

  public resolveConfirmation(
    executionId: string,
    approved: boolean,
    rejectionMessage?: LooseOptional<string>,
    confirmationId?: string
  ): ExecutionRecord {
    return this.interactions.resolveConfirmation(executionId, approved, rejectionMessage, confirmationId)
  }

  public provideInput(executionId: string, answer: string): ExecutionRecord {
    return this.interactions.provideInput(executionId, answer)
  }

  public provideInputForSourceSession(request: ExecutionProvideInputRequest): ExecutionRecord {
    const execution = this.findExecutionForSourceSession(
      request.sessionId,
      ['awaiting_input']
    )

    if (!execution) {
      throw new AppError('NOT_FOUND', '当前会话没有等待输入的执行。')
    }

    return this.provideInput(execution.id, request.answer)
  }

  public hasPendingInteractionForSourceSession(
    sessionId: string,
    kind: ExecutionPendingInteractionKind,
  ): boolean {
    return isPresent(
      this.getPendingInteractionForSourceSession(sessionId, kind)
    )
  }

  public isRunningForSourceSession(
    sessionId: string,
  ): boolean {
    return isPresent(
      this.findExecutionForSourceSession(sessionId, ['pending', 'running'])
    )
  }

  public getPendingInteractionForSourceSession(
    sessionId: string,
    kind: ExecutionPendingInteractionKind,
  ): Nullable<ExecutionPendingInteractionSnapshot> {
    const statuses: Array<ExecutionRecord['status']> =
      kind === 'confirmation' ? ['awaiting_confirmation'] : ['awaiting_input']
    const execution = this.findExecutionForSourceSession(
      sessionId,
      statuses
    )

    if (!execution) return null

    if (kind === 'confirmation') {
      const request = execution.awaitingConfirmation
      if (!request) return null
      return {
        kind: 'confirmation',
        executionId: execution.id,
        confirmationId: request.confirmationId,
        message: request.message,
        userActionCards: request.userActionCards,
      }
    }

    const request = execution.awaitingInput
    if (!request) return null
    return {
      kind: 'input',
      executionId: execution.id,
      question: request.question,
    }
  }

  public resolveConfirmationForSourceSession(
    request: ExecutionResolveConfirmationRequest
  ): ExecutionRecord {
    const execution = this.findExecutionForSourceSession(request.sessionId, [
      'awaiting_confirmation',
    ])

    if (!execution) {
      throw new AppError('NOT_FOUND', '当前会话没有等待确认的执行。')
    }
    const expectedCardIds = new Set(
      (execution.awaitingConfirmation?.userActionCards ?? []).map((card) => card.id)
    )
    const resultCardIds = request.userActionCardResults?.map((result) => result.cardId.trim()) ?? []
    if (!isEmpty(resultCardIds) && resultCardIds.some((cardId) => !expectedCardIds.has(cardId))) {
      throw new AppError('VALIDATION', '确认卡片已过期，请忽略这组旧卡片。')
    }

    // 卡结果必须进 decision.message:读卡结果决定语义的工具(如 proposal:review 要求
    // actionKind==='acknowledge' 才算批准)靠 readActionCardResults(decision.message) 解析。
    // 这里以结构化的 `userActionCardResults` 为**唯一真源**统一序列化;UI 曾把同一份 JSON
    // 借道 rejectionMessage 传输,那条历史约定已经删掉——留着只会让下游把一坨 JSON 当成
    // 用户写的拒绝理由读。所有调用方(UI / headless 的 hook resolve_confirmation)现在都只
    // 填结构化字段,不必知道任何借道约定;否则校验通过后卡结果被丢,approve 也会被这类工具
    // 判成退回。
    //
    // `rejectionMessage` **一并进同一个信封**,不做二选一:两者都显式给的调用方原本会静默
    // 丢掉拒绝理由(模型只收到一坨 JSON,永远不知道为什么被拒)。并存是安全的——解析端
    // `readActionCardResults` 按 key 取 `userActionCardResults`,忽略信封里的未知键;而只给
    // 理由不给卡结果的老路径仍走裸字符串,不把纯文本理由包成 JSON 增加下游解析负担。
    const message = !isEmpty(resultCardIds)
      ? JSON.stringify({
          userActionCardResults: request.userActionCardResults,
          // undefined 会被 JSON.stringify 直接略过，所以缺席即不出现在信封里。
          rejectionMessage: toOptional(request.rejectionMessage),
        })
      : request.rejectionMessage

    return this.resolveConfirmation(execution.id, request.approved, message, request.confirmationId)
  }

  /** 按 sourceSessionId 查找处于指定 status 的 execution（优先 active guard）。 */
  private findExecutionForSourceSession(
    sourceSessionId: string,
    statuses: Array<ExecutionRecord['status']>,
  ): Nullable<ExecutionRecord> {
    const sourceScopeId = sourceSessionId
    const activeExecutionId = this.sourceSessionGuard.getActiveExecutionId(sourceScopeId)
    if (activeExecutionId) {
      const activeExecution = this.store.require(activeExecutionId)
      if (statuses.includes(activeExecution.status)) return activeExecution
      return null
    }

    return this.records.findLatestBySourceSession(sourceSessionId, statuses)
  }
}

export { ExecutionInteractionFacade }
