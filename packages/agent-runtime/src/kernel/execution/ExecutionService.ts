import type { ModelMessage } from 'ai'

import { isBlank,isEmpty, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  ExecutionProvideInputRequest,
  ExecutionRecord,
  ExecutionResolveConfirmationRequest,
  ExecutionTaskRecord,
  StreamStatePayload,
  StreamTurnContextPayload,
  ToolConfirmationDecisionOptions,
  ToolExecutionPlanUpdate,
} from '@velaros-ai/core/types'

import { createChatStreamScopeKey } from '../../chat/stream'
import {
  ExecutionGuidanceQueue,
  type ExecutionIdFactory,
  ExecutionInteractions,
  ExecutionRecords,
  type ExecutionRouteProvider,
  ExecutionRoutingCoordinator,
  ExecutionStateMachine,
  ExecutionStore,
  extractGuidanceUserText,
  SourceSessionGuard,
  SubAgentGuidanceRelayRegistry,
} from '../../execution'
import type { AgentModSeamDispatcher } from '../../mods/AgentModSeams'

import { ExecutionAgentEventFacade } from './ExecutionAgentEventFacade'
import { ExecutionInteractionFacade } from './ExecutionInteractionFacade'
import { type ExecutionAbortOptions, ExecutionStateFacade } from './ExecutionStateFacade'
import { ExecutionTaskFacade } from './ExecutionTaskFacade'
import type {
  AuthGatePort,
  ExecutionActivitySignalsPort,
  ExecutionCollaborationPort,
  ExecutionGuidanceRelayPlanner,
  ExecutionRecordsPathPort,
  ExecutionResourcePort,
} from './host-ports'
import { ManagedExecutionRunner, type RunManagedExecutionParams } from './ManagedExecutionRunner'
import { createToolExecutionApi } from './ToolExecutionApiFactory'

interface ExecutionServiceOptions {
  /** 准入断言端口：托管执行启动前断言已授权（Desktop 注入 cloudSessionAccess）。 */
  authGate: AuthGatePort
  /** 执行记录落盘路径端口：未显式传 store 时用于构建默认持久化 ExecutionStore。 */
  executionRecordsPath: ExecutionRecordsPathPort
  store?: ExecutionStore
  guidanceRelayRegistry?: SubAgentGuidanceRelayRegistry
  guidanceRelayService?: ExecutionGuidanceRelayPlanner
  collaborationCoordinator?: ExecutionCollaborationPort
  notifyTerminalExecution?: (execution: ExecutionRecord) => void
  routeProvider?: ExecutionRouteProvider
  /** 可选 ID 工厂；用于多运行时隔离、确定性测试或接入宿主 ID 体系。 */
  idFactory?: ExecutionIdFactory
  /**
   * 可选 mod 拦截 seam 派发器（裁决 9 机制②）——注入时在托管执行进入/离开各派发一次
   * 会话生命周期钩子；缺省不注入 → 全链 no-op。钩子是纯通知：既不改执行入参，
   * 也不能否决执行（准入判定单源在 authGate 与策略门，钩子不可旁路）。
   */
  seams?: AgentModSeamDispatcher
}

/**
 * 执行领域服务。
 *
 * 这是 Agent 运行状态的中心：
 * - ExecutionRecords 负责创建/更新执行和任务记录。
 * - SourceSessionGuard 保证同一 chat session 不并发跑多个执行。
 * - ExecutionInteractions 管理“等待用户输入/确认”的 Promise。
 * - ExecutionAgentEventFacade 把 agent 事件写入调试时间线并同步 turn context。
 */
class ExecutionService {
  private readonly log = Log.tag('ExecutionService')
  /** 限制执行状态只能按合法方向变化。 */
  private readonly stateMachine = new ExecutionStateMachine()
  /** session 级互斥和 abort 管理。 */
  private readonly sourceSessionGuard = new SourceSessionGuard()
  /** 执行记录存储，开启 persist 后会写入本地文件。 */
  private readonly store: ExecutionStore
  /** 根据当前任务和角色计算下一步路由/委派建议。 */
  private readonly routingCoordinator: ExecutionRoutingCoordinator
  /** 对 ExecutionStore 的高层封装，集中处理 record/task/plan 更新。 */
  private readonly records: ExecutionRecords
  /** 用户输入和确认弹窗的等待/唤醒协调器。 */
  private readonly interactions: ExecutionInteractions
  /** 运行中引导消息队列；每条消息只在 agent loop 中消费一次。 */
  private readonly guidanceQueue = new ExecutionGuidanceQueue()
  /** 活跃子 Agent 注册表，供运行中引导 relay 使用。 */
  private readonly guidanceRelayRegistry: SubAgentGuidanceRelayRegistry
  /** 主 Agent 侧引导 relay 规划器。 */
  private readonly guidanceRelayService: Nullable<ExecutionGuidanceRelayPlanner>
  /** 用户输入、确认与 source session 查找相关 API。 */
  private readonly interactionFacade: ExecutionInteractionFacade
  /** agent 事件账本、turn context 缓存和 runtime 事件副作用。 */
  private readonly agentEventFacade: ExecutionAgentEventFacade
  /** execution 终态流转和等待状态清理。 */
  private readonly stateFacade: ExecutionStateFacade
  /** 任务、计划和委派建议相关 API。 */
  private readonly taskFacade: ExecutionTaskFacade
  /** 托管执行 lifecycle 模板，负责启动/收尾编排。 */
  private readonly managedRunner: ManagedExecutionRunner
  /** 准入断言端口；托管执行启动前校验已授权。 */
  private readonly authGate: AuthGatePort
  /** 可选 mod seam 派发器；缺省 null → 会话生命周期钩子全链 no-op。 */
  private readonly seams: Nullable<AgentModSeamDispatcher>

  constructor(
    private readonly executionResource: ExecutionResourcePort,
    private readonly activitySignals: ExecutionActivitySignalsPort,
    options: ExecutionServiceOptions
  ) {
    this.authGate = options.authGate
    this.seams = toNullable(options.seams)
    this.routingCoordinator = new ExecutionRoutingCoordinator(options.routeProvider)
    this.store =
      options.store ??
      new ExecutionStore({
        persist: true,
        persistencePath: options.executionRecordsPath.getExecutionRecordsPath(),
      })
    this.guidanceRelayRegistry =
      options.guidanceRelayRegistry ?? new SubAgentGuidanceRelayRegistry()
    this.guidanceRelayService = toNullable(options.guidanceRelayService)

    // records 是最底层状态写入口，其他协作者通过它读写执行记录。
    this.records = new ExecutionRecords(
      this.store,
      this.stateMachine,
      executionResource,
      this.routingCoordinator,
      options.idFactory,
    )
    // interactions 在等待用户操作时会设置 execution.awaiting*，并在 resolve 时刷新 debug。
    this.interactions = new ExecutionInteractions(
      this.records,
      (executionId, payload) => this.emitExecutionState(executionId, payload),
      (executionId) => this.emitExecutionDebug(executionId)
    )
    this.interactionFacade = new ExecutionInteractionFacade(
      this.interactions,
      this.records,
      this.sourceSessionGuard,
      this.store
    )
    this.stateFacade = new ExecutionStateFacade(
      this.records,
      this.interactions,
      (executionId) => this.emitExecutionDebug(executionId),
      (executionId, payload) => this.emitExecutionState(executionId, payload)
    )
    this.agentEventFacade = new ExecutionAgentEventFacade({
      records: this.records,
      store: this.store,
      emitExecutionDebug: (executionId) => this.emitExecutionDebug(executionId),
      getExecution: (executionId) => this.getExecution(executionId),
      completeExecution: (executionId) => this.completeExecution(executionId),
      abortExecution: (executionId, reason, options) =>
        this.abortExecution(executionId, reason, options),
      failExecution: (executionId, error) => this.failExecution(executionId, error),
    })
    this.taskFacade = new ExecutionTaskFacade(this.records, this.routingCoordinator)
    this.managedRunner = new ManagedExecutionRunner({
      log: this.log,
      records: this.records,
      sourceSessionGuard: this.sourceSessionGuard,
      store: this.store,
      executionResource: this.executionResource,
      activitySignals: this.activitySignals,
      collaborationCoordinator: options.collaborationCoordinator,
      createToolExecutionApi: (execution) => createToolExecutionApi(execution, this),
      handleAgentEvent: (executionId, event) =>
        this.agentEventFacade.handleAgentEvent(executionId, event),
      emitExecutionState: (executionId, payload) => this.emitExecutionState(executionId, payload),
      emitExecutionDebug: (executionId) => this.emitExecutionDebug(executionId),
      getExecution: (executionId) => this.getExecution(executionId),
      abortExecution: (executionId, reason) => this.abortExecution(executionId, reason),
      completeExecution: (executionId) => this.completeExecution(executionId),
      failExecution: (executionId, error) => this.failExecution(executionId, error),
      consumeExecutionGuidance: (executionId) => this.consumeExecutionGuidance(executionId),
      runtimeInputForExecution: (executionId) => this.guidanceQueue.port(executionId),
      finalizeExecutionGuidance: (executionId) => this.guidanceQueue.finalize(executionId),
      clearExecutionGuidance: (executionId) => this.guidanceQueue.clear(executionId),
      isTerminalStatus: (status) => this.isTerminalStatus(status),
      notifyTerminalExecution: options.notifyTerminalExecution,
    })
  }

  /**
   * 执行生命周期模板。
   *
   * 调用方只需要传入 run 回调；这里统一完成创建记录、建立 session 互斥、
   * 绑定 stream listener、状态收尾、异常转换和清理 listener。
   */
  public async runManagedExecution(params: RunManagedExecutionParams): Promise<ExecutionRecord> {
    this.authGate.assertAuthenticated()
    if (!this.seams) return this.managedRunner.run(params)

    await this.seams.dispatchSessionLifecycle({
      phase: 'start',
      executionId: null,
      sessionId: params.sourceSessionId,
      status: null,
    })
    let record: Nullable<ExecutionRecord> = null
    try {
      record = await this.managedRunner.run(params)
      return record
    } finally {
      await this.seams.dispatchSessionLifecycle({
        phase: 'end',
        executionId: record?.id ?? null,
        sessionId: params.sourceSessionId,
        status: record?.status ?? null,
      })
    }
  }

  /** 标记执行失败，并同步失败原因到当前任务和等待中的交互。 */
  public failExecution(executionId: string, error: string): ExecutionRecord {
    return this.stateFacade.failExecution(executionId, error)
  }

  /** 标记执行中断，并给 renderer 发送 aborted runtime 事件。 */
  public abortExecution(
    executionId: string,
    reason: string,
    options?: ExecutionAbortOptions
  ): ExecutionRecord {
    return this.stateFacade.abortExecution(executionId, reason, options)
  }

  /** 标记执行完成，并完成当前任务、清理等待状态。 */
  public completeExecution(executionId: string): ExecutionRecord {
    return this.stateFacade.completeExecution(executionId)
  }

  /** 工具调用需要“用户确认后继续”时进入这里。 */
  public async awaitConfirmation(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void> {
    return this.interactionFacade.awaitConfirmation(executionId, message, abortSignal, options)
  }

  /** 和 awaitConfirmation 类似，但返回 approve/reject 结果，不一定终止执行。 */
  public async awaitConfirmationDecision(
    executionId: string,
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<{ approved: boolean; message: Nullable<string> }> {
    return this.interactionFacade.awaitConfirmationDecision(
      executionId,
      message,
      abortSignal,
      options
    )
  }

  /** 工具或执行流程需要用户输入文本时进入这里。 */
  public async awaitUserInput(
    executionId: string,
    question: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    return this.interactionFacade.awaitUserInput(executionId, question, abortSignal)
  }

  /** renderer 对指定 execution 的确认响应。 */
  public resolveConfirmation(
    executionId: string,
    approved: boolean,
    rejectionMessage?: LooseOptional<string>
  ): ExecutionRecord {
    return this.interactionFacade.resolveConfirmation(executionId, approved, rejectionMessage)
  }

  /** renderer 对指定 execution 的文本输入响应。 */
  public provideInput(executionId: string, answer: string): ExecutionRecord {
    return this.interactionFacade.provideInput(executionId, answer)
  }

  /** renderer 只知道 sessionId 时，通过当前/最近执行找到等待输入的 execution。 */
  public provideInputForSourceSession(request: ExecutionProvideInputRequest): ExecutionRecord {
    return this.interactionFacade.provideInputForSourceSession(request)
  }

  /** renderer 只知道 sessionId 时，向当前活跃 execution enqueue 一条 user guidance。 */
  public async provideGuidanceForSourceSession(request: {
    sessionId: string
    message: ModelMessage
  }, authorization?: { assertCurrent(): void }): Promise<void> {
    authorization?.assertCurrent()
    const sourceScopeId = createChatStreamScopeKey(request.sessionId)
    const executionId = this.sourceSessionGuard.getActiveExecutionId(sourceScopeId)
    if (!executionId) {
      throw new AppError('VALIDATION', '当前会话没有正在运行的执行，无法发送引导。')
    }

    const userGuidance = extractGuidanceUserText(request.message)
    if (!userGuidance) {
      throw new AppError('VALIDATION', '引导消息为空或不是用户消息。')
    }

    const activeWorkers = this.guidanceRelayRegistry.listActiveWorkers(executionId)
    if (!isEmpty(activeWorkers) && this.guidanceRelayService) {
      try {
        authorization?.assertCurrent()
        const planned = await this.guidanceRelayService.planRelay({
          userGuidance,
          workers: activeWorkers,
        })
        authorization?.assertCurrent()

        for (const relay of planned.relays) {
          this.guidanceRelayRegistry.enqueueRelay(executionId, relay.threadId, relay.message)
        }

        if (planned.mainAgentMessage) {
          authorization?.assertCurrent()
          const enqueued = this.guidanceQueue.enqueue(executionId, {
            role: 'user',
            content: planned.mainAgentMessage,
          })
          this.assertGuidanceEnqueued(enqueued, '主控引导消息无效。')
        }

        this.log.info('sub-agent guidance relay planned', {
          executionId,
          workerCount: activeWorkers.length,
          relayCount: planned.relays.length,
          notifyMainAgent: !!planned.mainAgentMessage,
        })
        this.emitExecutionDebug(executionId)
        return
      } catch (error) {
        if (error instanceof AppError && error.code === 'AUTH') throw error
        this.log.warn('sub-agent guidance relay failed; falling back to main-agent queue', {
          executionId,
          error: AppError.getMessage(error),
        })
      }
    }

    authorization?.assertCurrent()
    const enqueued = this.guidanceQueue.enqueue(executionId, request.message)
    this.assertGuidanceEnqueued(enqueued, '引导消息为空或不是用户消息。')

    this.emitExecutionDebug(executionId)
  }

  /** renderer 中断指定 worker 线程，不影响主 execution。 */
  public abortSubAgentWorkerForSourceSession(request: {
    sessionId: string
    threadId: string
    reason?: LooseOptional<string>
  }): { aborted: boolean } {
    const sourceScopeId = createChatStreamScopeKey(request.sessionId)
    const executionId = this.sourceSessionGuard.getActiveExecutionId(sourceScopeId)
    if (!executionId) {
      throw new AppError('VALIDATION', '当前会话没有正在运行的执行，无法中断子智能体。')
    }

    const threadId = request.threadId.trim()
    if (isBlank(threadId)) {
      throw new AppError('VALIDATION', '子智能体 threadId 不能为空。')
    }

    const aborted = this.guidanceRelayRegistry.abortWorker(
      executionId,
      threadId,
      request.reason?.trim() || '用户中断了子智能体。'
    )

    this.log.info('sub-agent worker abort requested', {
      sourceSessionId: request.sessionId,
      executionId,
      threadId,
      aborted,
    })
    this.emitExecutionDebug(executionId)

    return { aborted }
  }

  /** renderer 向指定 worker 线程直接 relay 用户引导，不经过主控 planner。 */
  public relaySubAgentGuidanceForSourceSession(request: {
    sessionId: string
    threadId: string
    message: string
  }): { relayed: boolean } {
    const sourceScopeId = createChatStreamScopeKey(request.sessionId)
    const executionId = this.sourceSessionGuard.getActiveExecutionId(sourceScopeId)
    if (!executionId) {
      throw new AppError('VALIDATION', '当前会话没有正在运行的执行，无法向子智能体发送引导。')
    }

    const threadId = request.threadId.trim()
    if (isBlank(threadId)) {
      throw new AppError('VALIDATION', '子智能体 threadId 不能为空。')
    }

    const message = request.message.trim()
    if (isBlank(message)) {
      throw new AppError('VALIDATION', '引导消息不能为空。')
    }

    const relayed = this.guidanceRelayRegistry.enqueueRelay(executionId, threadId, message)

    this.log.info('sub-agent worker guidance relay requested', {
      sourceSessionId: request.sessionId,
      executionId,
      threadId,
      relayed,
    })
    this.emitExecutionDebug(executionId)

    return { relayed }
  }

  private consumeExecutionGuidance(executionId: string): Nullable<ModelMessage> {
    return this.guidanceQueue.consume(executionId)
  }

  private assertGuidanceEnqueued(
    result: ReturnType<ExecutionGuidanceQueue['enqueue']>,
    invalidMessage: string
  ): void {
    if (result.status === 'accepted') return
    if (result.status === 'closed') {
      throw new AppError('VALIDATION', '当前执行已进入收尾，无法再接受运行中引导。')
    }
    throw new AppError('VALIDATION', invalidMessage)
  }

  /** renderer 只知道 sessionId 时，通过当前/最近执行找到等待确认的 execution。 */
  public resolveConfirmationForSourceSession(
    request: ExecutionResolveConfirmationRequest
  ): ExecutionRecord {
    return this.interactionFacade.resolveConfirmationForSourceSession(request)
  }

  public hasPendingInteractionForSourceSession(
    sessionId: string,
    kind: 'confirmation' | 'input',
  ): boolean {
    return this.interactionFacade.hasPendingInteractionForSourceSession(
      sessionId,
      kind
    )
  }

  public isRunningForSourceSession(
    sessionId: string,
  ): boolean {
    return this.interactionFacade.isRunningForSourceSession(sessionId)
  }

  public getPendingInteractionForSourceSession(
    sessionId: string,
    kind: 'confirmation' | 'input',
  ): ReturnType<ExecutionInteractionFacade['getPendingInteractionForSourceSession']> {
    return this.interactionFacade.getPendingInteractionForSourceSession(
      sessionId,
      kind
    )
  }

  /** 用户点击停止时按 source session 中断当前活跃执行。 */
  public abortSourceSession(
    sourceSessionId: string,
  ): boolean {
    const sourceScopeId = createChatStreamScopeKey(sourceSessionId)
    const executionId = this.sourceSessionGuard.abort(sourceScopeId, '用户停止了运行。')
    if (!executionId) return false

    this.log.info('source session execution abort requested', {
      sourceSessionId,
      executionId,
    })
    return true
  }

  /** 宿主安全模块使用：中断同一 source session 下所有资源上下文的活跃执行。 */
  public abortSourceSessionAllContexts(sourceSessionId: string, reason = '用户停止了运行。'): boolean {
    const executionIds = this.sourceSessionGuard.abortAllForSourceSession(sourceSessionId, reason)
    if (isEmpty(executionIds)) return false

    this.log.info('source session all-context execution abort requested', {
      sourceSessionId,
      executionIds,
    })
    return true
  }

  /** Cloud 登录失效等系统级边界使用：一次中断所有活跃 agent 执行。 */
  public abortAllActive(reason = '系统停止了运行。'): readonly string[] {
    const executionIds = this.sourceSessionGuard.abortAll(reason)
    if (!isEmpty(executionIds)) {
      this.log.info('all active executions abort requested', { executionIds, reason })
    }
    return executionIds
  }

  /** 读取指定执行记录。 */
  public getExecution(executionId: string): ExecutionRecord {
    return this.records.getExecution(executionId)
  }

  /** 标记任务开始。 */
  public startTask(executionId: string, taskId: string): void {
    this.taskFacade.startTask(executionId, taskId)
  }

  /** 标记任务完成，可附带结果摘要。 */
  public completeTask(executionId: string, taskId: string, result?: LooseOptional<string>): void {
    this.taskFacade.completeTask(executionId, taskId, result)
  }

  /** 标记任务失败。 */
  public failTask(executionId: string, taskId: string, error: string): void {
    this.taskFacade.failTask(executionId, taskId, error)
  }

  /** 取当前正在执行的任务。 */
  public getCurrentTask(executionId: string): ExecutionTaskRecord {
    return this.taskFacade.getCurrentTask(executionId)
  }

  /** 取当前计划图。 */
  public getCurrentPlan(executionId: string) {
    return this.taskFacade.getCurrentPlan(executionId)
  }

  /** 更新当前计划图，供 plan/team 工具同步 UI。 */
  public updateCurrentPlan(executionId: string, input: ToolExecutionPlanUpdate) {
    return this.taskFacade.updateCurrentPlan(executionId, input)
  }

  /** 当前任务推荐的下一步动作，主要用于工具/角色路由。 */
  public getCurrentRecommendedAction(
    executionId: string
  ): ExecutionTaskRecord['recommendedAction'] {
    return this.taskFacade.getCurrentRecommendedAction(executionId)
  }

  /** 根据当前任务解析执行建议。 */
  public getCurrentExecutionAdvice(executionId: string) {
    return this.taskFacade.getCurrentExecutionAdvice(executionId)
  }

  /** 供外部 supervisor 调试：读取某个 source session 最近一次真实送入模型的 turn context。 */
  public getLatestTurnContextForSourceSession(
    sourceSessionId: string
  ): Nullable<{ execution: ExecutionRecord; turnContext: StreamTurnContextPayload }> {
    return this.agentEventFacade.getLatestTurnContextForSourceSession(sourceSessionId)
  }

  /** 向当前 execution 的 state listener 发状态事件。 */
  private emitExecutionState(executionId: string, payload: StreamStatePayload): void {
    this.store.emitState(executionId, payload)
  }

  /** 重新构建并发送 debug payload。 */
  private emitExecutionDebug(executionId: string): void {
    this.store.emitDebug(executionId)
  }

  /** completed/failed/aborted 都是终态，终态不再被自动覆盖。 */
  private isTerminalStatus(status: ExecutionRecord['status']): boolean {
    return status === 'aborted' || status === 'completed' || status === 'failed'
  }

  /**
   * 应用退出前 flush 节流写入。
   *
   * ExecutionStore 已切到 250ms 节流写盘；如果不在退出前 flush，最后一批
   * appendEvent / updateTask 调用产生的变更可能还停留在定时器队列里就被丢弃。
   */
  public async disposeAsync(): Promise<void> {
    await this.store.disposeAsync()
  }
}

export { ExecutionService }
export type { ExecutionServiceOptions }
