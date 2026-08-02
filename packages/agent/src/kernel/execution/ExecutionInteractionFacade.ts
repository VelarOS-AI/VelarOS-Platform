import { isEmpty,isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  ExecutionPendingInteractionKind,
  ExecutionPendingInteractionSnapshot,
  ExecutionProvideInputRequest,
  ExecutionRecord,
  ExecutionResolveConfirmationRequest,
  ToolConfirmationDecisionOptions,
} from '@velaros-ai/core/types'

import type {
  ExecutionInteractions,
  ExecutionRecords,
  ExecutionStore,
  SourceSessionGuard,
} from '../../execution'

/** 聚合用户确认、追问输入与 sourceSession 级 IPC 解析。 */
class ExecutionInteractionFacade {
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
    rejectionMessage?: LooseOptional<string>
  ): ExecutionRecord {
    return this.interactions.resolveConfirmation(executionId, approved, rejectionMessage)
  }

  public provideInput(executionId: string, answer: string): ExecutionRecord {
    return this.interactions.provideInput(executionId, answer)
  }

  /** renderer 按 sessionId 回答工具追问；要求存在 awaiting_input 的活跃 execution。 */
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

  /**
   * 该 source session 是否有正在执行（pending/running）的 execution。
   * 用 source-aware 查找（同 confirmation 路径），不依赖 runCoordinator 的精确 scope key——
   * 否则由外部入口发起、再由宿主分配 scope id 的 run 会因 scope 不匹配被误判为未运行。
   */
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

    return this.resolveConfirmation(execution.id, request.approved, message)
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
