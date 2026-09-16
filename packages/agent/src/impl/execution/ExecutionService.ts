// 域：执行服务——**一次 run 的所有权与生命周期**（会话互斥、待输入/待确认、持久化、中止）。
//
// **为什么需要它**：一个会话同时只能有一次执行在跑，而「跑」这件事横跨模型流、工具执行、
// 用户交互三种等待。没有单一所有者时，第二次发送会与第一次抢同一段历史，用户看到的是
// 消息错位与结果串台。本服务是那个所有者：run 的开始、挂起（等输入/等确认）、恢复、
// 中止、落盘都从这里发起。
//
// ## 关键不变量（改这些会破什么）
//  - **会话互斥**：同会话第二次 run 必须被拒绝或排队，不能并发跑。绕过 = 历史双写。
//  - **挂起不是结束**：等输入/等确认期间 run 仍然存活并持有互斥；把它当结束会让恢复时
//    找不到宿主状态（历史事故：确认后尾段不落盘）。
//  - **中止必须收敛到终态并落盘**：中止后不写终态 = 重启后看到一个永远「执行中」的会话。
//  - **session:start / session:end seam 在 finally 收尾**：mod 钩子必须对异常路径也可见，
//    否则 mod 记的账与实际执行数对不上。
import type { ModelMessage } from 'ai'

import { isBlank, isEmpty, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AuthGatePort, ExecutionActivitySignalsPort, ExecutionCollaborationPort, ExecutionGuidanceRelayPlanner, ExecutionIdFactory,ExecutionRecordsPathPort, ExecutionResourcePort } from '../../contract/requires.js'
import type {
  StreamTurnContextPayload,
  ToolConfirmationDecisionOptions,
  ToolExecutionPlanUpdate,
} from '../../types/agent'
import type { ExecutionPendingInteractionSnapshot, ExecutionProvideInputRequest, ExecutionRecord, ExecutionResolveConfirmationRequest, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecord,StreamStatePayload } from '../../types/agent.js'
import type { ExecutionAbortOptions, ExecutionGuidanceRelayPlanInput, RunManagedExecutionParams } from '../../types/execution.js'
import type { AgentModSeamDispatcherApi } from '../../types/mods.js'
import type { ExecutionRouteProvider } from '../../types/records.js'
import { assertGuidanceEnqueued, isTerminalExecutionStatus } from '../../utils/execution/managed-execution'
import { extractGuidanceUserText } from '../../utils/records/guidance-relay'
import { ChatRuntimeEvents } from '../../utils/wire/chat-runtime.js'
import { ExecutionRoutingCoordinator } from '../records/ExecRouting'
import { ExecutionStateMachine } from '../records/ExecStateMachine'
import { ExecutionGuidanceQueue } from '../records/ExecutionGuidanceQueue'
import { ExecutionInteractions } from '../records/ExecutionInteractions'
import { ExecutionRecords } from '../records/ExecutionRecords'
import { ExecutionStore } from '../records/ExecutionStore'
import { SourceSessionGuard } from '../records/SourceSessionGuard'
import { SubAgentGuidanceRelayRegistry } from '../records/SubAgentGuidanceRelayRegistry'
import { createToolExecutionApi } from '../tools/ToolExecutionApiBinding'

import { ExecutionAgentEventFacade } from './ExecutionAgentEventFacade'
import { ExecutionInteractionFacade } from './ExecutionInteractionFacade'
import { ExecutionStateFacade } from './ExecutionStateFacade'
import { ExecutionTaskFacade } from './ExecutionTaskFacade'
import { ManagedExecutionRunner } from './ManagedExecutionRunner'

/** `ExecutionService` 的装配参数：两个必填端口由产品宿主给，其余可选项不给就各自走内置实现或整条链路 no-op。 */
interface ExecutionServiceOptions {
  /** 准入断言端口：托管执行启动前由产品宿主确认当前运行态已获授权。 */
  authGate: AuthGatePort
  /** 执行记录落盘路径端口：未显式传 store 时用于构建默认持久化 ExecutionStore。 */
  executionRecordsPath: ExecutionRecordsPathPort
  /** 自带的执行记录存储；测试与多运行时隔离用它换掉默认的落盘 store，不传则按 `executionRecordsPath` 现建一个持久化的。 */
  store?: ExecutionStore
  /** 活跃子 Agent 注册表：主 Agent 收到运行中引导时按它找出该转给哪些 worker。不传则自建一份空的。 */
  guidanceRelayRegistry?: SubAgentGuidanceRelayRegistry
  /** 引导转发规划器（通常是一次辅助模型调用）：决定用户这句话该转给哪个 worker、怎么措辞。不传则只入主 Agent 队列，不转发。 */
  guidanceRelayService?: ExecutionGuidanceRelayPlanner
  /** 协作协调器：注入后每次托管执行会登记成一个主 Agent 协作者，供协作面展示与冲突判定；不传则整条协作面不参与。 */
  collaborationCoordinator?: ExecutionCollaborationPort
  /** 终态回调：执行落终态时通知宿主（发系统通知等）。它自己抛错不影响执行收尾。 */
  notifyTerminalExecution?: (execution: ExecutionRecord) => void
  /** 路由 provider：把当前任务算成「下一步建议」。不传则路由协调器给不出建议，提示词里对应的那句就不出。 */
  routeProvider?: ExecutionRouteProvider
  /** 可选 ID 工厂；用于多运行时隔离、确定性测试或接入宿主 ID 体系。 */
  idFactory?: ExecutionIdFactory
  /**
   * 可选 mod 拦截 seam 派发器（裁决 9 机制②）——注入时在托管执行进入/离开各派发一次
   * 会话生命周期钩子；缺省不注入 → 全链 no-op。钩子是纯通知：既不改执行入参，
   * 也不能否决执行（准入判定单源在 authGate 与策略门，钩子不可旁路）。
   */
  seams?: AgentModSeamDispatcherApi
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
export interface ExecutionServiceApi {
  /** 跑一次托管执行：建记录、领会话互斥、收尾落终态全在里面。返回终态记录；回调抛出的异常在记录落终态后继续外抛。服务正在关闭时直接抛 `EXECUTION_ABORTED`。 */
  runManagedExecution(params: RunManagedExecutionParams): Promise<ExecutionRecord>
  /** 等某个来源会话上所有在飞的托管执行结束（成功失败都算）；没有在飞的立即返回。用于需要顺序化的外部操作。 */
  awaitSourceSessionSettled(sessionId: string): Promise<void>
  /** 标记执行失败，并把原因同步到当前任务和所有在等的交互。 */
  failExecution(executionId: string, error: string): ExecutionRecord
  /** 标记执行中断，并默认向 renderer 发一条 aborted 事件（`emitStreamState: false` 可关掉，用于事件流里已经有那条的场合）。 */
  abortExecution(executionId: string, reason: string, options?: ExecutionAbortOptions): ExecutionRecord
  /** 标记执行完成，并完成当前任务、清掉等待状态。 */
  completeExecution(executionId: string): ExecutionRecord
  /** 工具需要「用户确认后继续」时在这里挂起；拒绝按约定终止执行。 */
  awaitConfirmation(executionId: string, message: string, abortSignal?: AbortSignal, options?: ToolConfirmationDecisionOptions): Promise<void>
  /** 同样等确认，但把批准/拒绝作为结果返回而不终止执行，`message` 带回用户理由或卡片结果。 */
  awaitConfirmationDecision(executionId: string, message: string, abortSignal?: AbortSignal, options?: ToolConfirmationDecisionOptions): Promise<{ approved: boolean; message: Nullable<string> }>
  /** 需要用户补一段文本时在这里挂起，返回用户答的原文。 */
  awaitUserInput(executionId: string, question: string, abortSignal?: AbortSignal): Promise<string>
  /** renderer 对指定执行的确认应答；`confirmationId` 用来对上具体那一次确认。 */
  resolveConfirmation(executionId: string, approved: boolean, rejectionMessage?: LooseOptional<string>, confirmationId?: string): ExecutionRecord
  /** renderer 对指定执行的追问应答。 */
  provideInput(executionId: string, answer: string): ExecutionRecord
  /** renderer 只有 sessionId 时的追问应答：找不到在等输入的执行就抛 `NOT_FOUND`。 */
  provideInputForSourceSession(request: ExecutionProvideInputRequest): ExecutionRecord
  /**
   * 用户在运行中途插一句话：先入主 Agent 的引导队列（抢占下一轮），再按活跃 worker 决定要不要另行转发给子 Agent。
   * 会话没有在跑、消息为空或不是用户消息、执行已进入收尾，都抛 `VALIDATION`。`authorization` 让调用方在每个可能让步的点上复核这次请求是否仍然当前。
   */
  provideGuidanceForSourceSession(request: { sessionId: string; message: ModelMessage; inputId?: string }, authorization?: { assertCurrent(): void }): Promise<void>
  /** 用户单独中断某个子 Agent 线程，不影响主执行；返回是否真的中断到了那条线程。会话没在跑或 threadId 为空时抛 `VALIDATION`。 */
  abortSubAgentWorkerForSourceSession(request: { sessionId: string; threadId: string; reason?: LooseOptional<string> }): { aborted: boolean }
  /** 用户直接把一句话转给某个子 Agent 线程，不经主控规划器；返回是否真的投递到了那条线程。 */
  relaySubAgentGuidanceForSourceSession(request: { sessionId: string; threadId: string; message: string }): { relayed: boolean }
  /** 收尾后把该会话上没被消费掉的引导 inputId 交回给宿主（宿主据此把这些输入还给用户），同时清掉对应队列。 */
  takeRetainedGuidanceInputIdsForSourceSession(sessionId: string): string[]
  /** renderer 只有 sessionId 时的确认应答：过期卡片抛 `VALIDATION`，找不到在等确认的执行抛 `NOT_FOUND`。 */
  resolveConfirmationForSourceSession(request: ExecutionResolveConfirmationRequest): ExecutionRecord
  /** 该会话此刻是否挂着某一类待处理交互；UI 据此显示等待态。 */
  hasPendingInteractionForSourceSession(sessionId: string, kind: 'confirmation' | 'input'): boolean
  /** 该会话是否有正在跑（pending / running）的执行。 */
  isRunningForSourceSession(sessionId: string): boolean
  /** 取该会话待处理交互的展示快照（确认文案与卡片，或追问问题）；没有则返回 null。 */
  getPendingInteractionForSourceSession(sessionId: string, kind: 'confirmation' | 'input'): Nullable<ExecutionPendingInteractionSnapshot>
  /** 用户点停止：中断该会话当前活跃的那次执行，返回是否真的有执行被中断。 */
  abortSourceSession(sourceSessionId: string): boolean
  /** 宿主安全模块用：中断同一来源会话下**所有**资源上下文里的活跃执行。 */
  abortSourceSessionAllContexts(sourceSessionId: string, reason?: string): boolean
  /** 系统级边界（如 Cloud 登录失效）用：一次中断所有活跃执行，返回被中断的 executionId 列表。 */
  abortAllActive(reason?: string): readonly string[]
  /** 读一条执行记录；不存在时由记录层抛错。 */
  getExecution(executionId: string): ExecutionRecord
  /** 标记某条任务开始执行。 */
  startTask(executionId: string, taskId: string): void
  /** 标记某条任务完成，可附结果摘要。 */
  completeTask(executionId: string, taskId: string, result?: LooseOptional<string>): void
  /** 标记某条任务失败并记下原因。 */
  failTask(executionId: string, taskId: string, error: string): void
  /** 取执行当前指向的那条任务记录。 */
  getCurrentTask(executionId: string): ExecutionTaskRecord
  /** 取当前计划图。 */
  getCurrentPlan(executionId: string): ExecutionTaskPlanStep[]
  /** 按模型给的增量更新当前计划图并返回更新后的整份，UI 随即同步。 */
  updateCurrentPlan(executionId: string, input: ToolExecutionPlanUpdate): ExecutionTaskPlanStep[]
  /** 取当前任务上记着的推荐下一步动作，供工具与角色路由参考。 */
  getCurrentRecommendedAction(executionId: string): ExecutionTaskRecord['recommendedAction']
  /** 按当前任务算一条执行建议；算不出来返回 null。 */
  getCurrentExecutionAdvice(executionId: string): Nullable<ExecutionTaskExecutionAdvice>
  /** 供外部 supervisor 调试：读该会话最近一次真实送进模型的轮次上下文；本进程内没缓存过就返回 null。 */
  getLatestTurnContextForSourceSession(sourceSessionId: string): Nullable<{ execution: ExecutionRecord; turnContext: StreamTurnContextPayload }>
  /** 停止准入、中断所有活跃执行、等它们收尾，最后把记录落盘。重复调用返回同一个 Promise。 */
  disposeAsync(): Promise<void>
}

class ExecutionService implements ExecutionServiceApi {
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
  private readonly managedRunsBySourceSession = new Map<string, Set<Promise<ExecutionRecord>>>()
  /** 关闭准入立即生效，实际清理回执覆盖启动钩子、运行和结束钩子。 */
  private closing = false
  private shutdown: Nullable<Promise<void>> = null
  /** 准入断言端口；托管执行启动前校验已授权。 */
  private readonly authGate: AuthGatePort
  /** 可选 mod seam 派发器；缺省 null → 会话生命周期钩子全链 no-op。 */
  private readonly seams: Nullable<AgentModSeamDispatcherApi>

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
      options.idFactory
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
      isTerminalStatus: (status) => isTerminalExecutionStatus(status),
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
    this.assertAcceptingExecutions()
    const run = this.runManagedExecutionLifecycle(params)
    const running =
      this.managedRunsBySourceSession.get(params.sourceSessionId) ??
      new Set<Promise<ExecutionRecord>>()
    running.add(run)
    this.managedRunsBySourceSession.set(params.sourceSessionId, running)
    try {
      return await run
    } finally {
      running.delete(run)
      if (running.size === 0) this.managedRunsBySourceSession.delete(params.sourceSessionId)
    }
  }

  public async awaitSourceSessionSettled(sessionId: string): Promise<void> {
    await Promise.allSettled([...(this.managedRunsBySourceSession.get(sessionId) ?? [])])
  }

  private async runManagedExecutionLifecycle(
    params: RunManagedExecutionParams
  ): Promise<ExecutionRecord> {
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
      this.assertAcceptingExecutions()
      this.authGate.assertAuthenticated()
      record = await this.managedRunner.run(params)
      return record
    } finally {
      await this.seams.dispatchSessionLifecycle({
        phase: 'end',
        executionId: toNullable(record?.id),
        sessionId: params.sourceSessionId,
        status: toNullable(record?.status),
      })
    }
  }

  private assertAcceptingExecutions(): void {
    if (this.closing) throw new AppError('EXECUTION_ABORTED', '执行服务正在关闭。')
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
    rejectionMessage?: LooseOptional<string>,
    confirmationId?: string
  ): ExecutionRecord {
    return this.interactionFacade.resolveConfirmation(
      executionId,
      approved,
      rejectionMessage,
      confirmationId
    )
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
  public async provideGuidanceForSourceSession(
    request: {
      sessionId: string
      message: ModelMessage
      inputId?: string
    },
    authorization?: { assertCurrent(): void }
  ): Promise<void> {
    authorization?.assertCurrent()
    const sourceScopeId = request.sessionId
    const executionId = this.sourceSessionGuard.getActiveExecutionId(sourceScopeId)
    if (!executionId || isTerminalExecutionStatus(this.getExecution(executionId).status)) {
      throw new AppError('VALIDATION', '当前会话没有正在运行的执行，无法发送引导。')
    }

    const userGuidance = extractGuidanceUserText(request.message)
    if (!userGuidance) {
      throw new AppError('VALIDATION', '引导消息为空或不是用户消息。')
    }

    // 在辅助模型工作前接收原始输入，使它及时抢占主轮。
    authorization?.assertCurrent()
    const enqueued = this.guidanceQueue.enqueue(executionId, request.message, {
      inputId: request.inputId,
      sourceSessionId: request.sessionId,
      onConsumed: request.inputId
        ? () =>
            this.emitExecutionState(executionId, ChatRuntimeEvents.inputApplied(request.inputId!))
        : undefined,
    })
    assertGuidanceEnqueued(enqueued, '引导消息为空或不是用户消息。')

    this.log.info('main-agent guidance enqueued', {
      executionId,
      sourceSessionId: request.sessionId,
    })

    this.emitExecutionDebug(executionId)

    const activeWorkers = this.guidanceRelayRegistry.listActiveWorkers(executionId)
    if (!isEmpty(activeWorkers) && this.guidanceRelayService) {
      void this.relayAcceptedGuidance(
        request.sessionId,
        executionId,
        { userGuidance, workers: activeWorkers },
        authorization
      )
    }
  }

  private async relayAcceptedGuidance(
    sessionId: string,
    executionId: string,
    input: ExecutionGuidanceRelayPlanInput,
    authorization?: { assertCurrent(): void }
  ): Promise<void> {
    try {
      const planner = this.guidanceRelayService
      if (!planner) return
      const planned = await planner.planRelay(input)
      authorization?.assertCurrent()
      if (
        this.sourceSessionGuard.getActiveExecutionId(sessionId) !== executionId ||
        isTerminalExecutionStatus(this.getExecution(executionId).status)
      )
        return

      for (const relay of planned.relays) {
        this.guidanceRelayRegistry.enqueueRelay(executionId, relay.threadId, relay.message)
      }
      this.log.info('sub-agent guidance relay planned', {
        executionId,
        workerCount: input.workers.length,
        relayCount: planned.relays.length,
      })
      this.emitExecutionDebug(executionId)
    } catch (error) {
      this.log.warn('sub-agent guidance relay failed after main-agent input acceptance', {
        executionId,
        error: AppError.getMessage(error),
      })
    }
  }

  /** renderer 中断指定 worker 线程，不影响主 execution。 */
  public abortSubAgentWorkerForSourceSession(request: {
    sessionId: string
    threadId: string
    reason?: LooseOptional<string>
  }): { aborted: boolean } {
    const sourceScopeId = request.sessionId
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
    const sourceScopeId = request.sessionId
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

  public takeRetainedGuidanceInputIdsForSourceSession(sessionId: string): string[] {
    return this.guidanceQueue.takeRetainedInputIds(sessionId)
  }

  /** renderer 只知道 sessionId 时，通过当前/最近执行找到等待确认的 execution。 */
  public resolveConfirmationForSourceSession(
    request: ExecutionResolveConfirmationRequest
  ): ExecutionRecord {
    return this.interactionFacade.resolveConfirmationForSourceSession(request)
  }

  public hasPendingInteractionForSourceSession(
    sessionId: string,
    kind: 'confirmation' | 'input'
  ): boolean {
    return this.interactionFacade.hasPendingInteractionForSourceSession(sessionId, kind)
  }

  public isRunningForSourceSession(sessionId: string): boolean {
    return this.interactionFacade.isRunningForSourceSession(sessionId)
  }

  public getPendingInteractionForSourceSession(
    sessionId: string,
    kind: 'confirmation' | 'input'
  ): ReturnType<ExecutionInteractionFacade['getPendingInteractionForSourceSession']> {
    return this.interactionFacade.getPendingInteractionForSourceSession(sessionId, kind)
  }

  /** 用户点击停止时按 source session 中断当前活跃执行。 */
  public abortSourceSession(sourceSessionId: string): boolean {
    const sourceScopeId = sourceSessionId
    const executionId = this.sourceSessionGuard.abort(sourceScopeId, '用户停止了运行。')
    if (!executionId) return false

    this.log.info('source session execution abort requested', {
      sourceSessionId,
      executionId,
    })
    return true
  }

  /** 宿主安全模块使用：中断同一 source session 下所有资源上下文的活跃执行。 */
  public abortSourceSessionAllContexts(
    sourceSessionId: string,
    reason = '用户停止了运行。'
  ): boolean {
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
      this.log.info('all active executions abort requested', {
        executionIds,
        reason,
      })
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
  public getCurrentExecutionAdvice(executionId: string): Nullable<ExecutionTaskExecutionAdvice> {
    return this.taskFacade.getCurrentExecutionAdvice(executionId)
  }

  /** 供外部 supervisor 调试：读取某个 source session 最近一次真实送入模型的 turn context。 */
  public getLatestTurnContextForSourceSession(sourceSessionId: string): Nullable<{
    execution: ExecutionRecord
    turnContext: StreamTurnContextPayload
  }> {
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

  /** 停止准入并取消执行，等待所有执行收尾后持久化最终记录。 */
  public disposeAsync(): Promise<void> {
    this.closing = true
    this.shutdown ??= Promise.resolve().then(async () => {
      this.abortAllActive('执行服务正在关闭。')
      await Promise.allSettled(
        [...this.managedRunsBySourceSession.values()].flatMap((runs) => [...runs])
      )
      await this.store.disposeAsync()
    })
    return this.shutdown
  }
}

export { ExecutionService }
export type { ExecutionServiceOptions }
