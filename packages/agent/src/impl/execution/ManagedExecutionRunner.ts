import type { ModelMessage } from 'ai'

import { AppError } from '@velaros-ai/core/error'
import type { Logger } from '@velaros-ai/core/logger'

import type { AgentRuntimeInputPort, ExecutionActivitySignalsPort, ExecutionCollaborationPort, ExecutionResourcePort, ToolExecutionApi } from '../../contract/requires.js'
import type { AgentEvent, ExecutionRecord, StreamStatePayload } from '../../types/agent'
import type { ExecutionAbortOptions, RunManagedExecutionParams } from '../../types/execution.js'
import { resolveAbortReason } from '../../utils/execution/managed-execution'
import { chatRuntimeEvents } from '../records/ChatRuntimeEvents'
import type { ExecutionRecords } from '../records/ExecutionRecords'
import type { ExecutionStoreApi } from '../records/ExecutionStore'
import type { SourceSessionGuard } from '../records/SourceSessionGuard'

/**
 * `ManagedExecutionRunner` 的注入面，由 `ExecutionService` 在构造时一次填齐。
 *
 * 全是**服务自己的能力**：本类不持有任何状态，生命周期模板要做的每一步都经这些回调打回服务，
 * 因此「谁是记录与终态的唯一所有者」这件事不会因为多一个模板类而分叉。
 */
interface ManagedExecutionRunnerDependencies {
  /** 服务的日志器（只用 info / warn）：启动、结束、被取代、收尾异常都从这里出，是排查执行串台的主线索。 */
  log: Pick<Logger, 'info' | 'warn'>
  /** 执行记录的高层读写口：创建 execution、流转 running、启动 root task 都走它。 */
  records: ExecutionRecords
  /** 会话级互斥：`start` 领运行权并拿到 abortController 与代次，`finish` 按代次释放，保证旧执行的收尾不会清掉新执行的互斥位。 */
  sourceSessionGuard: SourceSessionGuard
  /** 执行记录存储：本次执行期间在这里挂 executionId 级的 state / debug 监听，收尾时解绑。 */
  store: ExecutionStoreApi
  /** 执行资源端口：用于把这次执行映射到协作面的资源 id；取不到时只跳过协作者登记，不影响执行本身。 */
  executionResource: ExecutionResourcePort
  /** 活跃信号端口：开跑时开一段执行会话（宿主据此判定「有事在做」），收尾时释放。 */
  activitySignals: ExecutionActivitySignalsPort
  /** 可选协作协调器：注入时把本次执行登记成一个主 Agent 协作者，收尾时 complete；缺省则整条协作面不参与。 */
  collaborationCoordinator?: ExecutionCollaborationPort
  /** 为本次执行造一份工具侧的 execution API（计划、确认、追问等工具经它回到本执行）。 */
  createToolExecutionApi: (execution: ExecutionRecord) => ToolExecutionApi
  /** 每条 agent 事件的落点：在转发给订阅者**之前**先过一遍，写账本并按终态事件流转记录。 */
  handleAgentEvent: (executionId: string, event: AgentEvent) => void
  /** 向指定执行的 state 监听者发一条状态事件；本类只在通知「你被新请求取代了」时对**旧**执行用它。 */
  emitExecutionState: (executionId: string, payload: StreamStatePayload) => void
  /** 通知某条执行的调试快照需要重建并下发。 */
  emitExecutionDebug: (executionId: string) => void
  /** 读一条执行记录的当前状态；回调返回后与 finally 里都要先读它再决定怎么收尾。 */
  getExecution: (executionId: string) => ExecutionRecord
  /** 标记中止：回调返回时发现已被 abort、或捕获到 `EXECUTION_ABORTED` 时走这条。 */
  abortExecution: (
    executionId: string,
    reason: string,
    options?: ExecutionAbortOptions
  ) => ExecutionRecord
  /** 标记完成：只有回调正常返回、没被 abort、且记录仍是 running 时才调用。 */
  completeExecution: (executionId: string) => ExecutionRecord
  /** 标记失败：捕获到非中止类异常且记录尚未终结时走这条；异常随后仍向上抛。 */
  failExecution: (executionId: string, error: string) => ExecutionRecord
  /** 取一条用户中途注入的引导消息给 agent loop 消费；没有就返回 null。每条只会被取走一次。 */
  consumeExecutionGuidance: (executionId: string) => Nullable<ModelMessage>
  /** 取本次执行的运行时输入端口，交给 agent loop 在轮次边界读取用户追加的输入。 */
  runtimeInputForExecution: (executionId: string) => AgentRuntimeInputPort
  /**
   * 封口运行时输入并回报结果：`sealed` = 没有欠账；`pending` = 还有已接纳但没被消费的输入。
   * 刻意调两次（成功路径一次、finally 一次），必须幂等——只留一处就会漏掉抛出/中断那类路径。
   */
  finalizeExecutionGuidance: (
    executionId: string
  ) => { status: 'sealed' } | { status: 'pending'; pendingCount: number }
  /** 收尾期清理本次执行的输入队列；`retained` 表示还留着没清掉的条目，只记 warn 不阻断收尾。 */
  clearExecutionGuidance: (
    executionId: string
  ) => { status: 'cleared' } | { status: 'retained'; pendingCount: number }
  /** completed / aborted / failed 是否已经是终态：终态判定先于 complete，避免把已中断的执行改写成完成。 */
  isTerminalStatus: (status: ExecutionRecord['status']) => boolean
  /** 可选的终态通知（宿主用来发系统通知等）；只在记录确实处于终态时调用一次，它自己抛错只记 warn，不影响收尾。 */
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
 *
 * ## 三条时序不变量（错一条就是难查的串台）
 *  1. **`generation` 是 finally 的准入证**。同一 source scope 单活跃执行，新执行会顶掉旧的；
 *     旧执行的 finally 仍会跑，`sourceSessionGuard.finish(scope, generation)` 靠代次判等
 *     防止它把**新**执行的 guard 清掉。去掉 generation 的症状是"发第二条消息后第一条收尾，
 *     第二条随即失去互斥"。
 *  2. **`finalizeExecutionGuidance` 刻意调两次**。成功路径先调一次，是为了把"回调返回了但还有
 *     已接纳的运行时输入没消费"变成显式 INVARIANT（这类输入丢了不会报错，只是用户说的话没生效）；
 *     finally 再调一次覆盖抛出/中断路径。它必须幂等，改成只留一处会漏掉其中一类路径。
 *  3. **终态判定先于 complete**。回调正常返回不等于成功：先看 abortSignal，再看记录是否仍
 *     `running`，只有仍在 running 才 complete——否则会把已被中断/失败的执行改写成完成。
 *
 * ## 失败方向
 * 收尾期的每一件事（终态通知、guard 释放、输入清理、listener 解绑、协作者注销）都在 finally 里
 * 且各自不抛：收尾漏一步的代价是**该会话此后永久占着互斥位**，比丢一条通知严重得多。
 */
export interface ManagedExecutionRunnerApi {
  /**
   * 跑一次完整的托管执行，返回终态 `ExecutionRecord`。
   *
   * 顺序：建记录 → 领会话运行权（顺带通知被取代的旧执行）→ 挂 state/debug 监听 → 跑 `params.run` →
   * 按 abort 信号与记录状态落 completed / aborted / failed → finally 收尾。
   * 回调抛出的异常在记录落终态后**继续向上抛**，调用方不会拿到一个「看起来正常」的返回值。
   */
  run(params: RunManagedExecutionParams): Promise<ExecutionRecord>
}

class ManagedExecutionRunner implements ManagedExecutionRunnerApi {
  constructor(private readonly dependencies: ManagedExecutionRunnerDependencies) {}

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
    // 托管执行先创建 execution record；后续状态、调试和工具等待都围绕同一个 executionId 展开。
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
    events.emitState(chatRuntimeEvents.phase('creating-task'))
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
        chatRuntimeEvents.aborted(
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
      // 调用 SoloExecutionService 注入的 run，并传入取消控制器、执行 API 和带账本 tap 的事件总线。
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
            `执行 "${execution.id}" 已经返回，却还有 ${inputSettlement.pendingCount} 条被接收的运行时输入停在未结清状态。每条接收下来的输入都必须在执行收尾前有结论，否则调用方会一直等一个永远不来的回执——这是实现缺陷，不是用户操作错误。`
          )
        }
        completeExecution(execution.id)
      }
    } catch (error) {
      // Agent runtime 事件也能先行写入终态；catch 只在记录尚未终结时拥有流转权，
      // 否则同一异常会形成 aborted -> failed / completed -> failed 的二次终结。
      const appError = AppError.from(error)
      const latest = getExecution(execution.id)
      if (!isTerminalStatus(latest.status)) {
        if (appError.code === 'EXECUTION_ABORTED') {
          abortExecution(execution.id, appError.message)
        } else {
          failExecution(execution.id, appError.message)
        }
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

export { ManagedExecutionRunner }
export type { ManagedExecutionRunnerDependencies }
