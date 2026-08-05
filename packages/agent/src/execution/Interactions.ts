import type {
  ExecutionRecord,
  StreamStatePayload,
  ToolConfirmationDecisionOptions,
} from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import { AppError } from '@velaros-ai/core/error'

import { type ExecutionRecords } from './Records'

interface PendingInputResolver {
  /** 用户输入文本后唤醒 awaitUserInput。 */
  resolve: (answer: string) => void
  /** 执行失败/中断时拒绝等待中的 Promise。 */
  reject: (error: unknown) => void
}

interface ConfirmationDecision {
  /** 用户是否同意。 */
  approved: boolean
  /** 用户拒绝时可选填写的原因。 */
  message: Nullable<string>
}

interface PendingConfirmationResolver {
  /** 用户做出确认选择后唤醒 awaitConfirmationDecision。 */
  resolve: (decision: ConfirmationDecision) => void
  /** 执行失败/中断时拒绝等待中的 Promise。 */
  reject: (error: unknown) => void
  /** 拒绝确认是否直接终止执行。 */
  rejectTerminatesExecution: boolean
}

type PendingInputResolvers = Map<string, PendingInputResolver>
type PendingConfirmationResolvers = Map<string, PendingConfirmationResolver>
type PendingInteractionKind = 'confirmation' | 'input'

/** 拒绝确认时给模型/执行账的那句话：固定前缀 + 用户理由（有才拼）。 */
function buildConfirmationDenialMessage(rejectionMessage: Nullable<string>): string {
  return rejectionMessage
    ? `用户拒绝了本次确认请求：${rejectionMessage}`
    : '用户拒绝了本次确认请求。'
}

/**
 * 执行交互协调器。
 *
 * 工具需要用户确认或输入时，会把 execution 状态切到 awaiting_*，
 * 同时返回一个 Promise。renderer 后续通过 IPC 提交确认/输入，本类再 resolve/reject。
 */
class ExecutionInteractions {
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

  /** 等待用户确认；拒绝会终止执行。 */
  public async awaitConfirmation(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void> {
    await this.awaitConfirmationDecision(executionId, message, abortSignal, {
      ...options,
      rejectTerminatesExecution: true,
    })
  }

  /** 等待用户确认，并可配置拒绝是否终止执行。 */
  public async awaitConfirmationDecision(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options: ToolConfirmationDecisionOptions & { rejectTerminatesExecution?: boolean } = {}
  ): Promise<ConfirmationDecision> {
    this.assertNoPendingInteraction(executionId, 'confirmation')
    // 切换 execution/task 状态，并把等待确认事件发给 UI。
    const execution = this.records.transition(executionId, 'awaiting_confirmation')
    this.records.setTaskStatus(execution.id, execution.currentTaskId, 'awaiting_confirmation')
    this.records.setAwaitingConfirmation(
      executionId,
      message,
      options.userActionCards,
      options.detail
    )
    this.emitExecutionDebug(executionId)
    this.emitExecutionState(
      executionId,
      ChatRuntimeEvents.awaitingConfirmation(
        executionId,
        message,
        options.userActionCards,
        options.detail
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
        resolve: (decision) => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve(decision)
        },
        reject: (error) => {
          abortSignal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        rejectTerminatesExecution: options.rejectTerminatesExecution ?? true,
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
    this.emitExecutionState(executionId, ChatRuntimeEvents.awaitingInput(executionId, question))

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
    rejectionMessage?: LooseOptional<string>
  ): ExecutionRecord {
    const execution = this.records.getExecution(executionId)
    const resolver = this.pendingConfirmationResolvers.get(executionId)
    const normalizedResponseMessage = rejectionMessage?.trim() || null
    const denialMessage = buildConfirmationDenialMessage(normalizedResponseMessage)

    if (resolver) {
      this.pendingConfirmationResolvers.delete(executionId)
      if (approved) {
        resolver.resolve({ approved: true, message: normalizedResponseMessage })
      } else if (resolver.rejectTerminatesExecution) {
        // 普通确认拒绝会让 awaitConfirmation 抛 EXECUTION_DENIED。
        //
        // **理由必须随错误一起走**：终止型确认（权限闸 / 危险命令闸 / interaction:confirm）
        // 没有卡结果这条结构化通路，`message` 是用户那句话到达模型的**唯一**载体——
        // 工具面把 EXECUTION_DENIED 映成 `tool_denied` 时读的正是 `error.message`。
        // 丢掉它，"别在生产库上跑，改成 dry-run" 这种正是模型该收到的下一步指令就永远
        // 到不了模型，而 headless 回执还照报 `rejectionMessageSent:true`。
        resolver.reject(
          new AppError('EXECUTION_DENIED', denialMessage, undefined, {
            executionId,
            rejectionMessage: normalizedResponseMessage,
          })
        )
      } else {
        // decision 模式把拒绝作为结构化结果返回，执行继续。
        resolver.resolve({ approved: false, message: normalizedResponseMessage })
      }
    }

    if (!approved) {
      if (resolver && !resolver.rejectTerminatesExecution) {
        // 非终止型拒绝恢复 running，让模型拿到“跳过/拒绝”结果继续决策。
        const runningExecution = this.records.transition(executionId, 'running')
        this.records.setTaskStatus(execution.id, runningExecution.currentTaskId, 'running')
        const updatedExecution = this.records.clearAwaitingConfirmation(executionId)
        this.emitExecutionDebug(executionId)
        return updatedExecution
      }

      // 终止型拒绝会把 execution/task 标记为 failed；失败原因带上用户那句话，
      // 否则事后翻执行账只能看到一句无差别的"用户拒绝了"，分不出他到底要求了什么。
      const failedExecution = this.records.transition(executionId, 'failed')
      this.records.failTask(failedExecution.id, failedExecution.currentTaskId, denialMessage)

      this.records.clearAwaitingConfirmation(executionId)
      this.records.clearAwaitingInput(executionId)
      const updatedExecution = this.records.setExecutionError(executionId, denialMessage)
      this.emitExecutionDebug(executionId)
      return updatedExecution
    }

    // 同意后恢复 running，并清理 awaitingConfirmation。
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
export type { PendingConfirmationResolvers, PendingInputResolvers }
