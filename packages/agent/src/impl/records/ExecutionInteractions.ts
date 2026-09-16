import { AppError } from '@velaros-ai/core/error'

import type { ExecutionRecord, StreamStatePayload, ToolConfirmationDecisionOptions } from '../../types/agent'

import { type ExecutionRecords } from './ExecutionRecords'

/**
 * 执行里「停下来问用户」的那一半：工具要确认或要用户打字时，先把执行和当前任务切到 `awaiting_*` 状态、
 * 把等待事件发给界面，再返回一个挂着的 Promise；renderer 经 IPC 回传结果时才 resolve。
 *
 * 一次执行同时只许有一个待办交互，第二个发起会抛 `EXECUTION_INTERACTION_PENDING`。
 * 待办 resolver 只在内存里（executionId → resolver），进程重启即失效。
 * abort 信号到达时一律清掉 awaiting 状态再 reject，否则界面会残留一张点不动的确认卡。
 * 实现是 `ExecutionInteractions`，执行服务持一份。
 */
export interface ExecutionInteractionsApi {
  /** 执行失败或被中断时兜底：把这次执行上等待中的确认和输入全部以 `EXECUTION_ABORTED` 拒绝，免得调用方永远挂着。 */
  failPending(executionId: string, error: string): void
  /** 等用户确认，拒绝即取消当前操作：用户点同意时正常返回；点拒绝时抛 `EXECUTION_DENIED`，错误正文是「用户拒绝了本次确认请求」加上用户填的理由。 */
  awaitConfirmation(executionId: string, message: string, abortSignal?: AbortSignal, options?: ToolConfirmationDecisionOptions): Promise<void>
  /** 等用户确认，但拒绝也算正常结果：返回 `{ approved, message }`，调用方自己决定后续。被 abort 时抛 `EXECUTION_ABORTED`；这次执行已有待办交互时抛 `EXECUTION_INTERACTION_PENDING`。 */
  awaitConfirmationDecision(executionId: string, message: string, abortSignal?: AbortSignal, options?: ToolConfirmationDecisionOptions & { rejectTerminatesExecution?: boolean }): Promise<ConfirmationDecision>
  /** 等用户打一段文本：兑现值就是用户输入的原文。被 abort 时抛 `EXECUTION_ABORTED`；已有待办交互时抛 `EXECUTION_INTERACTION_PENDING`。 */
  awaitUserInput(executionId: string, question: string, abortSignal?: AbortSignal): Promise<string>
  /** renderer 回传确认结果：`confirmationId` 必须对得上当前那张卡，对不上抛 `VALIDATION`（旧卡片的回复不许猜是在答哪一张）。执行上已经没有待办确认时原样返回当前记录，迟到或重复的回复不会把停掉的执行救活。同意与拒绝都把状态切回 running，真正停止只走取消通道。 */
  resolveConfirmation(executionId: string, approved: boolean, rejectionMessage?: LooseOptional<string>, confirmationId?: string): ExecutionRecord
  /** renderer 回传用户输入：有等待中的 resolver 就兑现它；无论有没有，都把执行和当前任务切回 running 并清掉等待输入的标记，返回更新后的执行记录。 */
  provideInput(executionId: string, answer: string): ExecutionRecord
}

class ExecutionInteractions implements ExecutionInteractionsApi {
  /** executionId -> 等待文本输入的 resolver。 */
  private readonly pendingInputResolvers: PendingInputResolvers = new Map()
  /** executionId -> 等待确认的 resolver。 */
  private readonly pendingConfirmationResolvers: PendingConfirmationResolvers = new Map()

  constructor(
    /** 执行记录写入口。 */
    private readonly records: ExecutionRecords,
    /** 向 renderer 发送等待状态。 */
    private readonly emitExecutionState: (executionId: string, payload: StreamStatePayload) => void,
    /** 刷新执行调试图。 */
    private readonly emitExecutionDebug: (executionId: string) => void
  ) {}

  /** 执行失败/中断时，拒绝所有等待中的用户交互。 */
  public failPending(executionId: string, error: string): void {
    const pendingConfirmationResolver = this.pendingConfirmationResolvers.get(executionId)
    if (pendingConfirmationResolver) {
      this.pendingConfirmationResolvers.delete(executionId)
      pendingConfirmationResolver.reject(new AppError('EXECUTION_ABORTED', error))
    }

    const pendingInputResolver = this.pendingInputResolvers.get(executionId)
    if (pendingInputResolver) {
      this.pendingInputResolvers.delete(executionId)
      pendingInputResolver.reject(new AppError('EXECUTION_ABORTED', error))
    }
  }

  /** 等待用户确认；拒绝仅以工具错误取消当前操作。 */
  public async awaitConfirmation(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void> {
    const decision = await this.awaitConfirmationDecision(executionId, message, abortSignal, options)
    if (!decision.approved) throw new AppError(
      'EXECUTION_DENIED', buildConfirmationDenialMessage(decision.message)
    )
  }

  /** 等待用户确认；拒绝返回原因，任务继续。 */
  public async awaitConfirmationDecision(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options: ToolConfirmationDecisionOptions & { rejectTerminatesExecution?: boolean } = {}
  ): Promise<ConfirmationDecision> {
    this.assertNoPendingInteraction(executionId, 'confirmation')
    const confirmationId = `confirmation:${randomUUID()}`
    // 切换 execution/task 状态，并把等待确认事件发给 UI。
    const execution = this.records.transition(executionId, 'awaiting_confirmation')
    this.records.setTaskStatus(execution.id, execution.currentTaskId, 'awaiting_confirmation')
    this.records.setAwaitingConfirmation(
      executionId,
      message,
      options.userActionCards,
      options.detail,
      confirmationId
    )
    this.emitExecutionDebug(executionId)
    this.emitExecutionState(
      executionId,
      chatRuntimeEvents.awaitingConfirmation(
        executionId,
        message,
        options.userActionCards,
        options.detail,
        confirmationId
      )
    )

    return new Promise<ConfirmationDecision>((resolve, reject) => {
      if (abortSignal?.aborted) {
        // 起步分支同样需要清理 awaiting_confirmation：上面已经写了 awaiting 状态，
        // 若不回滚 + emit debug，UI 会卡在“等待确认”但不再有 resolver。
        this.pendingConfirmationResolvers.delete(executionId)
        this.records.clearAwaitingConfirmation(executionId)
        this.emitExecutionDebug(executionId)
        reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
        return
      }

      const onAbort = (): void => {
        // abort 时必须清理 awaiting 状态，否则 UI 会残留确认卡片。
        this.pendingConfirmationResolvers.delete(executionId)
        this.records.clearAwaitingConfirmation(executionId)
        this.emitExecutionDebug(executionId)
        reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
      }

      abortSignal?.addEventListener('abort', onAbort, { once: true })
      // resolver 放入 map，后续 resolveConfirmation 通过 executionId 找回。
      this.pendingConfirmationResolvers.set(executionId, {
        confirmationId,
        resolve: (decision) => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve(decision)
        },
        reject: (error) => {
          abortSignal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
    })
  }

  /** 等待用户输入文本。 */
  public async awaitUserInput(
    executionId: string,
    question: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    this.assertNoPendingInteraction(executionId, 'input')
    // 切换 execution/task 状态，并把等待输入事件发给 UI。
    const execution = this.records.transition(executionId, 'awaiting_input')
    this.records.setTaskStatus(execution.id, execution.currentTaskId, 'awaiting_input')
    this.records.setAwaitingInput(executionId, question)
    this.emitExecutionDebug(executionId)
    this.emitExecutionState(executionId, chatRuntimeEvents.awaitingInput(executionId, question))

    return new Promise<string>((resolve, reject) => {
      if (abortSignal?.aborted) {
        // 起步分支同样需要清理 awaiting_input：上方已写入 awaiting 状态，
        // 不回滚 + emit debug 的话 UI 会卡在“等待输入”但无 resolver 回应。
        this.pendingInputResolvers.delete(executionId)
        this.records.clearAwaitingInput(executionId)
        this.emitExecutionDebug(executionId)
        reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
        return
      }

      const onAbort = (): void => {
        // abort 时必须清理 awaiting 状态，否则 UI 会残留输入卡片。
        this.pendingInputResolvers.delete(executionId)
        this.records.clearAwaitingInput(executionId)
        this.emitExecutionDebug(executionId)
        reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
      }

      abortSignal?.addEventListener('abort', onAbort, { once: true })
      // resolver 放入 map，后续 provideInput 通过 executionId 找回。
      this.pendingInputResolvers.set(executionId, {
        resolve: (answer) => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve(answer)
        },
        reject: (error) => {
          abortSignal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
    })
  }

  /** renderer 提交确认结果。 */
  public resolveConfirmation(
    executionId: string,
    approved: boolean,
    rejectionMessage?: LooseOptional<string>,
    confirmationId?: string
  ): ExecutionRecord {
    const execution = this.records.getExecution(executionId)
    const resolver = this.pendingConfirmationResolvers.get(executionId)
    const normalizedResponseMessage = rejectionMessage?.trim() || null

    // 迟到或重复的确认不能复活已停止的 execution。
    if (!resolver) return execution
    // 缺身份的旧回复同样不能猜测当前卡；宿主先刷新挂起卡再由用户重新提交。
    if (confirmationId !== resolver.confirmationId) {
      throw new AppError('VALIDATION', '确认卡片已过期，请刷新当前确认请求后重试。')
    }
    this.pendingConfirmationResolvers.delete(executionId)
    resolver.resolve({ approved, message: normalizedResponseMessage })

    // 批准或拒绝均恢复 running；停止只走取消通道。
    const runningExecution = this.records.transition(executionId, 'running')
    this.records.setTaskStatus(execution.id, runningExecution.currentTaskId, 'running')
    const updatedExecution = this.records.clearAwaitingConfirmation(executionId)
    this.emitExecutionDebug(executionId)
    return updatedExecution
  }

  /** renderer 提交用户输入文本。 */
  public provideInput(executionId: string, answer: string): ExecutionRecord {
    const resolver = this.pendingInputResolvers.get(executionId)
    if (resolver) {
      this.pendingInputResolvers.delete(executionId)
      resolver.resolve(answer)
    }

    const execution = this.records.transition(executionId, 'running')
    this.records.setTaskStatus(execution.id, execution.currentTaskId, 'running')
    const updatedExecution = this.records.clearAwaitingInput(executionId)
    this.emitExecutionDebug(executionId)
    return updatedExecution
  }

  private assertNoPendingInteraction(
    executionId: string,
    nextKind: PendingInteractionKind
  ): void {
    const currentKind = this.getPendingInteractionKind(executionId)
    if (!currentKind) return

    throw new AppError(
      'EXECUTION_INTERACTION_PENDING',
      `当前执行已有等待中的用户${currentKind === 'confirmation' ? '确认' : '输入'}，不能同时发起新的用户${nextKind === 'confirmation' ? '确认' : '输入'}。`,
      undefined,
      {
        executionId,
        currentKind,
        nextKind,
      }
    )
  }

  private getPendingInteractionKind(executionId: string): Nullable<PendingInteractionKind> {
    if (this.pendingConfirmationResolvers.has(executionId)) return 'confirmation'
    if (this.pendingInputResolvers.has(executionId)) return 'input'
    return null
  }
}

export { ExecutionInteractions }
import { randomUUID } from 'node:crypto'

import type { ConfirmationDecision, PendingConfirmationResolvers, PendingInputResolvers, PendingInteractionKind } from '../../types/records.js'
import { buildConfirmationDenialMessage } from '../../utils/records/execution-interactions'

import { chatRuntimeEvents } from './ChatRuntimeEvents'
