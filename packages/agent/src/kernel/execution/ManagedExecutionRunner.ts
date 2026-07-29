import type { ModelMessage } from 'ai'

import { isBlank, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { Logger } from '@velaros-ai/core/logger'
import type {
  AgentEvent,
  ExecutionRecord,
  StreamStatePayload,
  ToolExecutionApi,
} from '@velaros-ai/core/types'
import { ChatRuntimeEvents } from '@velaros-ai/core/types'

import type { AgentRuntimeInputPort } from '../../agent/RuntimeInputPort'
import type { ExecutionRecords, ExecutionStore, SourceSessionGuard } from '../../execution'

import type { ExecutionEventBus } from './ExecutionEventBus'
import type { ExecutionAbortOptions } from './ExecutionStateFacade'
import type {
  ExecutionActivitySignalsPort,
  ExecutionCollaborationPort,
  ExecutionResourcePort,
} from './host-ports'

interface ManagedExecutionController {
  /** 已创建并写入 store 的执行记录。 */
  execution: ExecutionRecord
  /** 当前执行的取消控制器，会透传给 Agent 和工具。 */
  abortController: AbortController
  /** 工具可调用的执行 API，用于创建任务、等待确认、更新计划等。 */
  executionApi: ToolExecutionApi
  /** 已加上 agent tap 的事件总线。 */
  events: ExecutionEventBus
  /** 手动刷新 debug payload，供计划/任务变化后立即同步 UI。 */
  emitDebug: () => void
  /** 读取并移除本执行下一条运行中引导消息。 */
  consumeGuidance: () => Nullable<ModelMessage>
  /** 原子运行时输入端口；final drain 后 seal。 */
  runtimeInput: AgentRuntimeInputPort
}

interface RunManagedExecutionParams {
  /** renderer/source 会话 id。 */
  sourceSessionId: string
  /** 同一 source session 内的宿主 scope。 */
  sourceScopeMetadata?: LooseOptional<Record<string, unknown>>
  /** 原始模型消息。 */
  messages: ModelMessage[]
  /** 调用方提供的事件总线。 */
  events: ExecutionEventBus
  /** 需要被宿主协作层观察的执行者；纯聊天不需要声明。 */
  collaborationActor?: {
    kind: 'main-agent'
    operation: string
    summary?: string
  }
  /** 真正执行业务的回调，由具体 execution host 注入。 */
  run: (controller: ManagedExecutionController) => Promise<void>
}

interface ManagedExecutionRunnerDependencies {
  log: Pick<Logger, 'info' | 'warn'>
  records: ExecutionRecords
  sourceSessionGuard: SourceSessionGuard
  store: ExecutionStore
  executionResource: ExecutionResourcePort
  activitySignals: ExecutionActivitySignalsPort
  collaborationCoordinator?: ExecutionCollaborationPort
  createToolExecutionApi: (execution: ExecutionRecord) => ToolExecutionApi
  handleAgentEvent: (executionId: string, event: AgentEvent) => void
  emitExecutionState: (executionId: string, payload: StreamStatePayload) => void
  emitExecutionDebug: (executionId: string) => void
  getExecution: (executionId: string) => ExecutionRecord
  abortExecution: (
    executionId: string,
    reason: string,
    options?: ExecutionAbortOptions
  ) => ExecutionRecord
  completeExecution: (executionId: string) => ExecutionRecord
  failExecution: (executionId: string, error: string) => ExecutionRecord
  consumeExecutionGuidance: (executionId: string) => Nullable<ModelMessage>
  runtimeInputForExecution: (executionId: string) => AgentRuntimeInputPort
  finalizeExecutionGuidance: (
    executionId: string
  ) => { status: 'sealed' } | { status: 'pending'; pendingCount: number }
  clearExecutionGuidance: (
    executionId: string
  ) => { status: 'cleared' } | { status: 'retained'; pendingCount: number }
  isTerminalStatus: (status: ExecutionRecord['status']) => boolean
  notifyTerminalExecution?: (execution: ExecutionRecord) => void
}

/**
 * **托管执行**生命周期模板：创建 `record` → `session` 互斥 → 绑定 `store listener` → 回调 `run` → 收尾。
 *
 * ## 职责边界
 * - 本类**不**直接跑 `Agent`；`params.run` 由 {@link SoloExecutionService} 注入
 * - 负责 `executionId` 级 `state`/`debug` 监听、`abortController`、`supersede` 通知、`finally` 清理
 *
 * ## 与 `ExecutionService` 关系
 * `ExecutionService` 持有本 `runner` 并传入 `records`/`store`/`guard` 等依赖；
 * 所有 chat execution host 均通过 `runManagedExecution` 进入此处。
 */
class ManagedExecutionRunner {
  constructor(private readonly dependencies: ManagedExecutionRunnerDependencies) {}

  /**
   * 执行一次完整托管 `run`。
   *
   * 流程：`createExecution` → `sourceSessionGuard.start` → 绑定 `store listeners` →
   * `params.run(controller)` → 根据 `abort`/`status` 标记 `completed`/`aborted`/`failed` → `finally` 清理。
   *
   * @returns 终态 `ExecutionRecord`（含 `status`、`error` 等）
   */
  public async run(params: RunManagedExecutionParams): Promise<ExecutionRecord> {
    const {
      abortExecution,
      completeExecution,
      createToolExecutionApi,
      emitExecutionDebug,
      emitExecutionState,
      failExecution,
      consumeExecutionGuidance,
      runtimeInputForExecution,
      finalizeExecutionGuidance,
      clearExecutionGuidance,
      getExecution,
      handleAgentEvent,
      isTerminalStatus,
      log,
      records,
      sourceSessionGuard,
      store,
      executionResource,
      activitySignals,
      collaborationCoordinator,
    } = this.dependencies
    const startedAt = Date.now()
    // TODO[主链路-20]: 托管执行模板第一步创建 execution record；后续 state/debug/工具等待都围绕这个 executionId 展开。
    const execution = records.createExecution({
      sourceSessionId: params.sourceSessionId,
      messages: params.messages,
    })
    const sourceScopeId = params.sourceSessionId
    // member=session：一个成员会话即一个 source scope，单活跃执行。
    const { abortController, generation, supersededExecutionId } = sourceSessionGuard.start(
      sourceScopeId,
      execution.id
    )
    // withAgentTap 会在所有 agent 事件转发前先写入 ledger。
    const events = params.events.withAgentTap((event) => handleAgentEvent(execution.id, event))
    // Store listener 是 executionId 级别的，只在本次执行期间绑定。
    store.setStateListener(execution.id, (payload) => events.emitState(payload))
    store.setDebugListener(execution.id, (payload) => events.emitDebug(payload))
    emitExecutionDebug(execution.id)
    records.transition(execution.id, 'running')
    // 每个 execution 默认至少有一个 root task，启动后标记为 running。
    const rootTaskId = execution.currentTaskId
    records.startTask(execution.id, rootTaskId)
    events.emitState(ChatRuntimeEvents.phase('creating-task'))
    log.info('execution task created', {
      executionId: execution.id,
      sourceSessionId: params.sourceSessionId,
      taskId: rootTaskId,
    })
    const releaseActivitySignalSession = activitySignals.beginExecutionSession(sourceScopeId)
    const collaborationActor = params.collaborationActor && collaborationCoordinator
      ? this.registerCollaborationActor({
          coordinator: collaborationCoordinator,
          executionResource,
          sourceSessionId: params.sourceSessionId,
          execution,
          operation: params.collaborationActor.operation,
          summary: params.collaborationActor.summary,
        })
      : null
    log.info('managed execution start', {
      executionId: execution.id,
      sourceSessionId: params.sourceSessionId,
    })

    if (supersededExecutionId) {
      emitExecutionState(
        supersededExecutionId,
        ChatRuntimeEvents.aborted(
          '运行被新的请求取代。',
          supersededExecutionId,
          'EXECUTION_ABORTED'
        )
      )
      log.info('source session execution superseded', {
        sourceSessionId: params.sourceSessionId,
        sourceScopeMetadata: params.sourceScopeMetadata,
        previousExecutionId: supersededExecutionId,
        nextExecutionId: execution.id,
      })
    }

    try {
      // TODO[主链路-22]: 这里回调到 SoloExecutionService 注入的 run，携带 abortController、executionApi 和带 ledger tap 的事件总线。
      await params.run({
        execution,
        abortController,
        executionApi: createToolExecutionApi(execution),
        events,
        emitDebug: () => emitExecutionDebug(execution.id),
        consumeGuidance: () => consumeExecutionGuidance(execution.id),
        runtimeInput: runtimeInputForExecution(execution.id),
      })

      // run 回调正常返回后，根据当前状态决定 completed 还是 aborted。
      const latest = getExecution(execution.id)
      if (abortController.signal.aborted && !isTerminalStatus(latest.status)) {
        abortExecution(execution.id, resolveAbortReason(abortController.signal.reason))
      } else if (latest.status === 'running') {
        const inputSettlement = finalizeExecutionGuidance(execution.id)
        if (inputSettlement.status === 'pending') {
          throw new AppError(
            'INVARIANT',
            `Execution "${execution.id}" returned with ${inputSettlement.pendingCount} accepted runtime input(s) still pending.`
          )
        }
        completeExecution(execution.id)
      }
    } catch (error) {
      // AppError code 决定是用户/系统中断还是执行失败。
      const appError = AppError.from(error)
      if (appError.code === 'EXECUTION_ABORTED') {
        abortExecution(execution.id, appError.message)
      } else {
        failExecution(execution.id, appError.message)
      }
      throw error
    } finally {
      const latest = getExecution(execution.id)
      const inputSettlement = finalizeExecutionGuidance(execution.id)
      log.info('managed execution end', {
        executionId: execution.id,
        status: latest.status,
        durationMs: Date.now() - startedAt,
        inputSettlement,
      })
      if (isTerminalStatus(latest.status)) {
        this.notifyTerminalExecution(latest)
      }
      // generation 防止旧执行 finally 把新执行的 session guard 清掉。
      sourceSessionGuard.finish(sourceScopeId, generation)
      const inputCleanup = clearExecutionGuidance(execution.id)
      if (inputCleanup.status === 'retained') {
        log.warn('accepted runtime input retained after execution settlement', {
          executionId: execution.id,
          pendingCount: inputCleanup.pendingCount,
        })
      }
      store.clearStateListener(execution.id)
      store.clearDebugListener(execution.id)
      collaborationActor?.complete()
      releaseActivitySignalSession?.()
    }

    return getExecution(execution.id)
  }

  private notifyTerminalExecution(execution: ExecutionRecord): void {
    const notifyTerminalExecution = this.dependencies.notifyTerminalExecution
    if (!notifyTerminalExecution) return

    try {
      notifyTerminalExecution(execution)
    } catch (error) {
      this.dependencies.log.warn('managed execution terminal notification failed', {
        executionId: execution.id,
        error: AppError.getMessage(error),
      })
    }
  }

  private registerCollaborationActor(input: {
    coordinator: ExecutionCollaborationPort
    executionResource: ExecutionResourcePort
    sourceSessionId: string
    execution: ExecutionRecord
    operation: string
    summary?: string
  }) {
    let resourceId: Nullable<string>
    try {
      resourceId = input.executionResource.getExecutionResourceId(input.sourceSessionId)
    } catch (error) {
      this.dependencies.log.info('managed execution collaboration actor skipped', {
        sourceSessionId: input.sourceSessionId,
        executionId: input.execution.id,
        reason: AppError.getMessage(error),
      })
      return null
    }

    return input.coordinator.registerActor({
      actorId: `main-agent:${input.sourceSessionId}:${input.execution.id}`,
      kind: 'main-agent',
      resourceId,
      sessionId: input.sourceSessionId,
      executionId: input.execution.id,
      status: 'active',
      summary: input.summary ?? input.operation,
    })
  }
}

function resolveAbortReason(reason: unknown): string {
  if (isString(reason) && !isBlank(reason.trim())) return reason
  if (reason instanceof Error && !isBlank(reason.message.trim())) return reason.message
  return '运行被终止'
}

export { ManagedExecutionRunner }
export type {
  ManagedExecutionController,
  ManagedExecutionRunnerDependencies,
  RunManagedExecutionParams,
}
