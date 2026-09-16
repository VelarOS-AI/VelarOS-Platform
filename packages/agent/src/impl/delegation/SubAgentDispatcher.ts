// 域：按需子 Agent **派发决策与运行编排**（并发闸/熔断闸解析、类型路由、模型路由健康度反馈、
// 写租约、沙箱作用域、worker 事件投影、失败/中断回灌）。
//
// 本体 host 无关，只认端口不认实现（见 ./host-ports）：产品宿主注入具体的 Agent runner、
// 配置服务、协作协调器与自定义 Agent 注册表，它们结构上满足端口。文案格式化见
// ./result-format，指令拼装见 ./instruction，并发闸见 ./concurrency，进展账本/摘要见 ./SubAgentProgress*。
//
// ## 从哪读起
// `dispatch()` 是唯一入口，顺序做四件事：**解析身份/类型 → 过三道闸 → 建会话与事件面 → 交给
// `runWorker`**。`runWorker` 之后的链路是 `runWithOptionalWriteLease`（解析路由，唯一转换器）→
// `executeWithRoute`（路由降级 + 写租约）→ `runRouteWithTransientRetry`（网络重试）。
//
// ## ① 三道闸是**三件不同的事**，刻意不合并
//  1. **并发闸**（每 executionKey 一个 Semaphore，缺省 4）——限制同时在跑几个，超出排队不拒绝；
//  2. **总量闸**（`DefaultMaxSubAgentsPerExecution` = 32）——限制一次执行总共派几个，超出**拒绝**；
//  3. **熔断闸**（`SubAgentProgressLedger`）——限制「同一件事反复派」，按提示词指纹硬拦、按同目标往返软提醒。
// 合并任意两条都会丢掉一类保护：并发闸挡不住「串行派 500 个」，总量闸挡不住「原样重发 3 次」，
// 熔断闸挡不住「一次并发 50 个把机器打满」。三条各自独立计数、独立回收（`clearExecution`）。
//
// ## ② 并发与时序（改这些会破什么）
//  - **信号量必须在 `finally` 释放**。`runWorker` 的 try 覆盖了从 `acquire()` 之后到全部收尾的
//    整段；任何一条提前 return 绕过 finally，都会永久漏掉一个槽位——症状是「派了几次子 Agent 之后
//    再派就一直不动」，且重启才恢复。同一 finally 还负责摘 relay 注册与清取消标记，三件事必须同生共死。
//  - **取消可能早于 worker 注册**。用户点取消时 worker 或许还卡在 `acquire()` 排队。
//    `cancelAsyncWorker` 先把 key 记进 `cancelledAsyncThreads`，`runWorker` 在 `registerWorker` 之后
//    **立刻自查并消费**该标记（`delete` 返回 true 即 abort）——这个「注册后自查」就是二者的会合点。
//    去掉它，取消会在 worker 真正启动前丢失，表现为「点了取消但子 Agent 照跑完」。
//  - **executionKey 必须由 `resolveSubAgentExecutionKey` 单源解析**：dispatch 与 AgentRunner 的
//    clearExecution 用同一函数，key 漂移会让清理误伤别的执行、或漏清导致计数永不归零。
//  - **中断不算失败**。`isAbortError` 在重试、路由降级、健康度反馈三处都先判：把中断喂给
//    `markFailure` 会污染 provider 健康度（用户按一次停止，模型被判定为「不可用」）。
//
// ## ③ 续跑（resume）的身份校验为什么这么严
// `validateResumeIdentity` 逐项比对 parent session / 资源（resourceId）/ 类型 / 自定义 agent id /
// readonly / tool_scope / 工具分类集合 / model / route_category。判据：续跑 = **复用一段既有对话历史**，
// 任何一项不一致都意味着这段历史是在另一套前提下产生的，接着跑会让模型带着错误前提工作——那类错误
// 既不报错也不好查。失败方向选「拒绝并要求新派」。**不比对 execution**：线程本来就要跨执行续跑
// （见 ④），同一父会话的下一轮换一个 executionId 是常态。
//
// ## ④ 线程跨执行保留：续跑省的是重读成本
// 子 Agent 读过的上下文就在它的线程历史里。`clearExecution` 因此只**回收执行作用域的状态**（计数、
// 信号量、进展账本、relay），线程交给 `SubAgentSessionStore` 脱离执行、按父会话有限保留（上限见
// AgentExecutionLimits.subAgentRetained*）；续跑时把线程重新挂到当前执行上，中断 / relay / 收尾照常。
//  - failed / aborted 的线程**也能续跑**：历史只在轮次边界回写，留下的部分是自洽的；续跑指令会告诉
//    子 Agent 上次异常结束、先核对现状。
//  - 带 thread_id 却查无此线程（过期、被挤出、从未存在）**明确失败**，绝不静默新建 worker——续跑的
//    prompt 通常只写追加任务，拿它从零起一个空白 worker 只会让模型在不自洽的指令上瞎猜。
//  - 历史为空或超出体积上限的线程不可续跑，结果里 `resumable=false`，父 Agent 据此改为新派。
import { randomUUID } from 'node:crypto'

import { isBoolean, isEmpty, isPresent, Log, toNullable, toOptional, truncate } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentRuntimeCapabilityPorts, CustomSubAgentRegistry, SubAgentConfigPort, SubAgentQueryRunner, SubAgentTypeProvider } from '../../contract/requires.js'
import type { SubAgentTaskResult, SubAgentUsage, TeamModelSelectionTrace, ThinkingDepth, ToolCategoryId } from '../../types/agent.js'
import type { DispatchPlan, ResolvedDispatchPlan, ResolvedSubAgentTypeConfig, SubAgentDispatchCatalog, SubAgentDispatchLimitsSnapshot, SubAgentDispatchRequest, SubAgentModelChoice, SubAgentResumeBriefing, SubAgentRetryState, SubAgentThreadRetention, SubAgentToolCategoryRequestResult, SubAgentToolContext, SubAgentWorkerExecutionOutput, TeamModelRouteResult, WorkerStatusArgs } from '../../types/delegation.js'
import type { AgentExecutionLimitOverrides, AgentExecutionLimits } from '../../types/loop.js'
import type { ExecutionEventBusContract, SubAgentGuidanceRelayWorkerHandle } from '../../types/records.js'
import { resolveCapabilityDelegationPolicy } from '../../utils/capabilities'
import { applySubAgentEffortOverride, applySubAgentModelOverride, buildResumeDispatchRequest, resolveEffectiveSubAgentTypeConfig, resolveInitialSubAgentToolCategories, resolveSubAgentRouteCategory, resolveSubAgentTypeKey, validateSubAgentResumeIdentity } from '../../utils/delegation/dispatch-plan'
import { attachSubAgentWorkerProbes, buildAutonomousSubAgentParentCtx, buildSubAgentAsyncThreadKey, combineAbortSignals, emitSubAgentDangerousConfirmationCard, emitSubAgentWorkerStatus, formatSubAgentTransientRetryStatus, isSubAgentAbortError } from '../../utils/delegation/dispatch-worker'
import { dedupeToolCategories, formatModelFallbackNote } from '../../utils/delegation/dispatcher'
import { buildSubAgentDispatchInstruction, buildSubAgentResumeBriefing, buildSubAgentResumeInstruction } from '../../utils/delegation/instruction'
import { formatSubAgentBackgroundArtifact, formatSubAgentFailureRedispatchGuidance, formatSubAgentStartedMessage, formatSubAgentTaskResultForParent, formatSubAgentThreadUnavailableMessage, formatSubAgentThreadUnresumableMessage, resolveSubAgentAgentName } from '../../utils/delegation/result-format'
import { resolveReadonlyMode } from '../../utils/delegation/sub-agent-readonly-policy'
import { buildSubAgentTaskResult } from '../../utils/delegation/sub-agent-result-builder'
import { resolveCustomSubAgentTypeConfig, resolveSubAgentTypeConfig } from '../../utils/delegation/sub-agent-type-registry'
import { resolveAgentExecutionLimits } from '../../utils/loop/execution-limits'
import { AgentTuning } from '../../utils/tuning'
import { RetryPolicy } from '../loop/RetryPolicy'
import type { KernelBackgroundJobManagerApi } from '../records/KernelBackgroundJobManager'
import type { SubAgentGuidanceRelayRegistryApi } from '../records/SubAgentGuidanceRelayRegistry'
import { createUnattendedSubAgentApprovalPort } from '../tools/UnattendedSubAgentApprovalPort'

import { Semaphore } from './Semaphore'
import { SubAgentProgressDigestRecorder } from './SubAgentProgressDigestRecorder'
import { SubAgentProgressLedger } from './SubAgentProgressLedger'
import { SubAgentSessionStore } from './SubAgentSessionStore'
import type { TeamModelRouterApi } from './TeamModelRouter'
import type { WriteLeaseCoordinatorApi } from './WriteLeaseCoordinator'

/**
 * 解析子智能体派发/清理共用的 executionKey。
 *
 * 优先用 execution.executionId；缺省时回退到 sessionId。dispatch() 与 AgentRunner 的
 * clearExecution() 必须用同一函数，避免 key 漂移导致误清其他执行的子 Agent。
 */
function resolveSubAgentExecutionKey(args: {
  executionId?: LooseOptional<string>
  sessionId: string
}): string {
  const executionId = args.executionId?.trim()
  if (executionId) return executionId
  return args.sessionId
}

/**
 * 按需子智能体派发器。
 *
 * 主智能体通过 agent:dispatch 工具触发；负责并发上界（按执行隔离）、类型路由、
 * 模型路由健康度反馈、写租约、工作线程事件投影，以及失败/中断的回灌处理。
 */
export interface SubAgentDispatcherApi {
  /**
   * 绑定真正跑 Agent 的 runner；宿主装配收尾时调一次。
   *
   * 派发器建出来时还没有 runner（二者互相依赖），没绑就 `dispatch` 会抛 `INTERNAL`。
   */
  bindAgentRunner(agentRunner: SubAgentQueryRunner): void
  /**
   * 某次执行此刻的**真实**派发配额（并发上限 / 总量上限 / 还能派几个）。
   *
   * 存在的唯一理由：工作流的 lane 调度器不许自带第二本并发账，它按这份真值开 runner、钳自己的 max_agents。
   * **只读、不建闸**——查配额不该给一个可能永远不派子 Agent 的执行留下信号量记录。
   */
  describeExecutionLimits(args: {
    executionId?: LooseOptional<string>
    sessionId: string
  }): SubAgentDispatchLimitsSnapshot
  /** 给正在跑的某条线程发中断信号，成功发出返回 true；线程不在跑返回 false。用户点停止、父会话释放、后台任务取消都走它。 */
  abortWorker(executionKey: string, threadId: string, reason?: string): boolean
  /** 给正在跑的某条线程追加一条指令（relay），入队成功返回 true；线程不在跑或队列不可用返回 false。 */
  relayGuidance(executionKey: string, threadId: string, message: string): boolean
  /**
   * 派发（或续跑、中断）一个子 Agent，返回**给父 Agent 看的文本结果**——唯一入口。
   *
   * 顺序是：解析身份与类型 → 过并发/总量/熔断三道闸 → 建线程与事件面 → 跑 worker。
   * `sync` 阻塞到子 Agent 收尾并把结果内联返回；`async` 立刻返回一条可等待的后台任务说明。
   * 被闸拦下、类型未知、thread_id 查无此线程等情况一律返回一段说明文字而不是抛错——父 Agent 据此改道。
   */
  dispatch(request: SubAgentDispatchRequest): Promise<string>
  /** 可派发的子 Agent 类型目录（内置 + 自定义）与默认类型 id；id 冲突时内置优先，与执行期的解析口径一致。 */
  describeDispatchCatalog(): SubAgentDispatchCatalog
  /**
   * 父会话被删除时由宿主调用：中断该会话仍在跑的子 Agent，并丢掉它的全部线程（含保留期内的）。
   *
   * 执行作用域的计数、信号量与账本不在这里回收，它们仍跟着各自执行的 `clearExecution` 走。
   */
  releaseParentSession(parentSessionId: string): void
  /**
   * 顶层执行结束：中断仍在跑的 worker，回收本次执行的计数、信号量、进展账本与取消标记。
   *
   * 子 Agent 线程**不删**——脱离执行转入保留期，供同一父会话的后续执行带 thread_id 续跑。
   * executionKey 必须与 `dispatch` 用同一个解析函数算出来，key 漂移会误清别的执行或漏清导致计数永不归零。
   */
  clearExecution(executionKey: string): void
}

class SubAgentDispatcher implements SubAgentDispatcherApi {
  /** 回报给主 Agent 的同厂商可选模型上限：自定义/聚合厂商的目录可能很长，结果里只放前若干个。 */
  private static readonly MaxReportedSelectableModels = AgentTuning.delegation.maxReportedSelectableModels
  /** 子 Agent 遇到瞬态故障最多重试几次。 */
  private static readonly SubAgentTransientRetryMaxAttempts = AgentTuning.delegation.transientRetryMaxAttempts
  /** 同一时刻最多并发跑几个子 Agent。 */
  private static readonly DefaultMaxConcurrentSubAgents = AgentTuning.delegation.maxConcurrentSubAgents
  /** 一次执行里累计最多派发多少个子 Agent。 */
  private static readonly DefaultMaxSubAgentsPerExecution = AgentTuning.delegation.maxSubAgentsPerExecution
  /** 派发前就被拦下（没有建线程、或线程已不在）的结果：明确告诉父 Agent 这个 thread_id 续不了。 */
  private static readonly UnavailableThreadRetention: SubAgentThreadRetention = Object.freeze({
    resumable: false,
    reason: 'not-found',
  })

  /** 每个顶层执行独立的并发信号量，避免跨会话/窗口互相阻塞排队。 */
  private readonly semaphores = new Map<string, Semaphore>()
  private readonly dispatchCountByExecution = new Map<string, number>()
  /** 派发进展账本：无进展熔断（A）+ 跨派发发现复用（B），按执行隔离。 */
  private readonly progressLedger = new SubAgentProgressLedger()
  /** 子 Agent 线程：执行期挂在执行上，执行结束后按父会话有限保留供续跑（见文件头 ④）。 */
  private readonly sessionStore: SubAgentSessionStore
  private readonly connectionRetryHelper = new RetryPolicy()
  private readonly cancelledAsyncThreads = new Set<string>()
  private readonly log = Log.tag('SubAgentDispatcher')
  private agentRunner: Nullable<SubAgentQueryRunner> = null
  private readonly executionLimits: AgentExecutionLimits

  constructor(
    private readonly modelRouter: TeamModelRouterApi,
    private readonly writeLeaseCoordinator: WriteLeaseCoordinatorApi,
    private readonly configService: SubAgentConfigPort,
    private readonly guidanceRelayRegistry: SubAgentGuidanceRelayRegistryApi,
    private readonly subAgentTypeProvider: SubAgentTypeProvider,
    private readonly capabilityPorts?: AgentRuntimeCapabilityPorts,
    private readonly backgroundJobManager?: KernelBackgroundJobManagerApi,
    private readonly customAgentRegistry?: CustomSubAgentRegistry,
    executionLimitOverrides: AgentExecutionLimitOverrides = {}
  ) {
    this.executionLimits = resolveAgentExecutionLimits(executionLimitOverrides)
    this.sessionStore = new SubAgentSessionStore({ limits: this.executionLimits })
  }

  public bindAgentRunner(agentRunner: SubAgentQueryRunner): void {
    this.agentRunner = agentRunner
  }

  private getAgentRunner(): SubAgentQueryRunner {
    if (!this.agentRunner) {
      throw new AppError('INTERNAL', 'SubAgentDispatcher 尚未绑定 AgentRunner。')
    }
    return this.agentRunner
  }

  /** 并发上限的**唯一计算式**；`getSemaphore` 与 `describeExecutionLimits` 共用，杜绝两处默认值。 */
  private resolveConcurrencyLimit(): number {
    return (
      this.configService.systemConfig.advancedRuntime?.maxConcurrentSubAgents ??
      SubAgentDispatcher.DefaultMaxConcurrentSubAgents
    )
  }

  /** 取得（或惰性创建）某次执行的并发信号量；上限取配置（advancedRuntime.maxConcurrentSubAgents）。 */
  private getSemaphore(executionKey: string): Semaphore {
    const existing = this.semaphores.get(executionKey)
    if (existing) return existing
    const created = new Semaphore(this.resolveConcurrencyLimit())
    this.semaphores.set(executionKey, created)
    return created
  }

  /**
   * 某次执行此刻的**真实**派发配额。
   *
   * 存在的唯一理由：`agent:run_workflow` 不许自带第二本并发/总量账。workflow 的 lane 调度器按
   * `maxConcurrentSubAgents` 开 runner、按 `remainingDispatchBudget` 钳自己的 `max_agents`，
   * 因此它回给模型的 `effective_limits` 就是运行时真值，而不是一个与信号量无关的声明常量。
   *
   * **只读、不建闸**：查配额不该给一个可能永远不派子 Agent 的执行留下一条信号量记录；
   * 上限走 `resolveConcurrencyLimit()` 这个共用计算式，因此与 `getSemaphore` 建出来的那个数
   * 恒等。已建闸时直接读闸上的值——配置在执行中途被改小也不会让 workflow 看到一个
   * 与正在排队的那把闸不同的数。
   */
  public describeExecutionLimits(args: {
    executionId?: LooseOptional<string>
    sessionId: string
  }): SubAgentDispatchLimitsSnapshot {
    const executionKey = resolveSubAgentExecutionKey(args)
    const maxConcurrentSubAgents =
      this.semaphores.get(executionKey)?.maxConcurrency ?? this.resolveConcurrencyLimit()
    const used = this.dispatchCountByExecution.get(executionKey) ?? 0
    return {
      maxConcurrentSubAgents,
      maxSubAgentsPerExecution: SubAgentDispatcher.DefaultMaxSubAgentsPerExecution,
      remainingDispatchBudget: Math.max(0, SubAgentDispatcher.DefaultMaxSubAgentsPerExecution - used),
    }
  }

  public abortWorker(executionKey: string, threadId: string, reason?: string): boolean {
    return this.guidanceRelayRegistry.abortWorker(executionKey, threadId, reason)
  }

  public relayGuidance(executionKey: string, threadId: string, message: string): boolean {
    return this.guidanceRelayRegistry.enqueueRelay(executionKey, threadId, message)
  }

  public async dispatch(request: SubAgentDispatchRequest): Promise<string> {
    const executionKey = resolveSubAgentExecutionKey({
      executionId: request.executionId ?? request.config.execution?.executionId,
      sessionId: request.parentCtx.sessionId,
    })
    const dispatchMode = request.input.mode ?? 'sync'
    const requestedThreadId = request.input.threadId?.trim()
    // 先清掉过期 / 超额的保留线程，下面的查找才能如实回答「这条线程还在不在」。
    this.sessionStore.prune()

    if (requestedThreadId && request.input.interrupt)
      return this.handleInterruptDispatch(request, executionKey, requestedThreadId)

    const existingSession = requestedThreadId
      ? this.sessionStore.getSession(requestedThreadId)
      : null
    // 带了 thread_id 却查无此线程：明确失败，绝不静默新建 worker（理由见文件头 ④）。
    if (requestedThreadId && !existingSession) return formatSubAgentTaskResultForParent(
        buildSubAgentTaskResult({
          threadId: requestedThreadId,
          text: formatSubAgentThreadUnavailableMessage(requestedThreadId),
          status: 'failed',
          retention: SubAgentDispatcher.UnavailableThreadRetention,
        })
      )
    const isResume = !!existingSession
    // 上一次运行的结局必须在状态被改成 running 之前读出来。
    const resumeBriefing = isResume ? buildSubAgentResumeBriefing(existingSession!) : null

    const dispatchRequest = isResume
      ? buildResumeDispatchRequest(request, existingSession!)
      : request

    const requestedType = dispatchRequest.input.subagentType?.trim()
    const injectedType = requestedType
      ? this.subAgentTypeProvider.getDescriptor(requestedType)
      : this.subAgentTypeProvider.getDescriptor(this.subAgentTypeProvider.defaultTypeId)
    const customAgent =
      requestedType && !injectedType
        ? toNullable(this.customAgentRegistry?.get(requestedType))
        : null
    if (requestedType && !injectedType && !customAgent) return formatSubAgentTaskResultForParent(
        buildSubAgentTaskResult({
          threadId: requestedThreadId ?? `subagent:${randomUUID()}`,
          text: this.formatUnknownSubagentTypeMessage(requestedType),
          status: 'failed',
          retention: SubAgentDispatcher.UnavailableThreadRetention,
        })
      )

    const subagentType = customAgent
      ? customAgent.base
      : requestedType ?? this.subAgentTypeProvider.defaultTypeId
    const baseTypeConfig = customAgent
      ? resolveCustomSubAgentTypeConfig(this.subAgentTypeProvider, customAgent)
      : resolveSubAgentTypeConfig(this.subAgentTypeProvider, subagentType)
    const readonlyOverride = isBoolean(dispatchRequest.input.readonly)
      ? dispatchRequest.input.readonly
      : toOptional(customAgent?.readonly)
    const readonlyMode = resolveReadonlyMode(baseTypeConfig.readonlyDefault, readonlyOverride)
    const typeConfig = resolveEffectiveSubAgentTypeConfig(baseTypeConfig, readonlyMode)
    const initialToolCategories = resolveInitialSubAgentToolCategories(dispatchRequest, typeConfig)

    if (isResume && requestedThreadId) {
      const resumeIdentityError = validateSubAgentResumeIdentity(
        dispatchRequest,
        requestedThreadId,
        existingSession!,
        typeConfig,
        readonlyMode,
        initialToolCategories
      )
      if (resumeIdentityError) return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: requestedThreadId,
            text: resumeIdentityError,
            status: 'failed',
          })
        )

      const resumeEarly = this.tryResumeExistingSession(
        dispatchRequest,
        executionKey,
        requestedThreadId,
        dispatchMode,
        existingSession!
      )
      if (resumeEarly) return resumeEarly

      // 运行中的线程上面已经转成 relay；到这里的线程都已收尾，再确认它真有可续的上下文。
      const retention = this.sessionStore.describeRetention(requestedThreadId)
      if (!retention.resumable) return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: requestedThreadId,
            text: formatSubAgentThreadUnresumableMessage(requestedThreadId, retention.reason),
            status: 'failed',
            retention,
          })
        )
    }

    const title =
      dispatchRequest.input.description?.trim() ||
      truncate(dispatchRequest.input.prompt.trim(), 80) ||
      `${typeConfig.subagentType} sub-agent`

    const signature = this.progressLedger.buildSignature(
      resolveSubAgentTypeKey(typeConfig),
      dispatchRequest.input.prompt,
      dispatchRequest.input.description
    )
    let progressEvaluation: ReturnType<SubAgentProgressLedger['evaluate']> | { kind: 'continue' } =
      { kind: 'continue' }

    if (!isResume) {
      progressEvaluation = this.progressLedger.evaluate(executionKey, signature)
      if (progressEvaluation.kind === 'hard-stop') return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: `subagent:${randomUUID()}`,
            text: `已跳过本次子智能体派发：${progressEvaluation.note}`,
            status: 'failed',
            retention: SubAgentDispatcher.UnavailableThreadRetention,
          })
        )

      const used = this.dispatchCountByExecution.get(executionKey) ?? 0
      if (used >= SubAgentDispatcher.DefaultMaxSubAgentsPerExecution) return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: `subagent:${randomUUID()}`,
            text: `本次执行已达到子智能体派发上限（${SubAgentDispatcher.DefaultMaxSubAgentsPerExecution}）。请直接完成剩余工作或合并任务。`,
            status: 'failed',
            retention: SubAgentDispatcher.UnavailableThreadRetention,
          })
        )
      this.dispatchCountByExecution.set(executionKey, used + 1)
    }

    // 续跑时必须复用已有 session 的 threadId（existingSession 正是按 requestedThreadId 取出的），
    // 否则后续 updateSession 会落到一个新生成、并不存在的 threadId 上。
    const threadId =
      isResume && requestedThreadId ? requestedThreadId : `subagent:${randomUUID()}`
    const activationId = `${threadId}:activation:${randomUUID()}`
    const agentName = resolveSubAgentAgentName(
      dispatchRequest.input.agentName ?? existingSession?.request.agent_name,
      threadId
    )
    const retryState: SubAgentRetryState = {
      hasVisibleOutput: false,
      hasToolUse: false,
    }
    const progressDigest = new SubAgentProgressDigestRecorder()
    const workerEvents = attachSubAgentWorkerProbes(
      request.events.forWorkerExecution({
        threadId,
        activationId,
        taskId: executionKey,
        title,
        agentName,
        roleId: typeConfig.roleId,
        phase: typeConfig.workerPhase,
      }),
      retryState,
      progressDigest
    )

    const resolvedModel = dispatchRequest.input.model?.trim() || customAgent?.model || null
    // reasoning effort 覆盖（D7）：显式请求优先，其次自定义 agent frontmatter，缺省 null=继承会话 effort。
    const resolvedEffort: Nullable<ThinkingDepth> =
      dispatchRequest.input.effort ?? toNullable(customAgent?.effort)
    const statusBase = {
      request: dispatchRequest,
      threadId,
      activationId,
      executionKey,
      title,
      agentName,
      typeConfig,
      dispatchMode,
      resolvedModel,
    }

    emitSubAgentWorkerStatus({ ...statusBase, status: 'pending', summary: title })

    const autonomousParentCtx = buildAutonomousSubAgentParentCtx(
      dispatchRequest.parentCtx,
      createUnattendedSubAgentApprovalPort,
      (status, summary) => {
        emitSubAgentWorkerStatus({ ...statusBase, status, summary })
        if (status === 'awaiting_confirmation') {
          emitSubAgentDangerousConfirmationCard({ ...statusBase, summary })
        }
      },
      { agentId: threadId, label: agentName }
    )

    if (isResume) {
      // 续跑的线程挂到本次执行上：中断、relay 与本次执行收尾时的脱离都按新执行生效。
      this.sessionStore.attachToExecution(threadId, executionKey)
      this.sessionStore.updateSession(threadId, {
        status: 'running',
        request: {
          prompt: dispatchRequest.input.prompt,
          description: dispatchRequest.input.description,
          mode: dispatchMode,
          readonly: readonlyMode,
          effort: resolvedEffort,
        },
      })
    } else {
      this.sessionStore.createSession({
        threadId,
        executionId: executionKey,
        parentSessionId: dispatchRequest.parentCtx.sessionId,
        resourceId: dispatchRequest.parentCtx.resourceId,
        subagentType: typeConfig.subagentType,
        prompt: dispatchRequest.input.prompt,
        description: dispatchRequest.input.description,
        mode: dispatchMode,
        readonly: readonlyMode,
        toolScope: dispatchRequest.input.toolScope ?? 'type_default',
        toolCategories: initialToolCategories,
        model: resolvedModel,
        routeCategory: resolveSubAgentRouteCategory(dispatchRequest, typeConfig),
        agentName,
        request: {
          custom_agent_id: toNullable(typeConfig.customAgentId),
          effort: resolvedEffort,
        },
      })
    }

    if (!isResume) {
      this.progressLedger.recordDispatch(executionKey, signature)
    }
    // 「已知上下文」前缀只给新派的 worker：续跑的 worker 历史里已有它自己的发现。
    const priorFindingsBriefing = isResume
      ? null
      : this.progressLedger.buildPriorFindingsBriefing(executionKey)

    // sync 与 async 都创建后台 job 供侧边栏看进度流；区别只在父 Agent 是否阻塞等结果：
    // - async：fire-and-forget，立即返回可等待 job（父继续，稍后 job:wait 收束）。
    // - sync：阻塞直到子 Agent 完成，把最终结果内联返回给父 Agent（无需再轮询 job），
    //   同时 runWorker 仍把进度写进该 job，UI 照样能看到实时轨迹。
    const backgroundJobId =
      dispatchMode === 'async' || this.backgroundJobManager
        ? this.startSubAgentBackgroundJob({
            request: dispatchRequest,
            executionKey,
            threadId,
            title,
          })
        : null

    if (dispatchMode === 'async') {
      this.sessionStore.setStatus(threadId, 'running')
      const worker = this.runWorker({
        request: dispatchRequest,
        autonomousParentCtx,
        typeConfig,
        workerEvents,
        title,
        threadId,
        initialToolCategories,
        priorFindingsBriefing,
        statusBase,
        progress: progressEvaluation,
        dispatchMode,
        resumeBriefing,
        readonlyMode,
        resolvedModel,
        resolvedEffort,
        retryState,
        backgroundJobId,
        progressDigest,
      })
      if (backgroundJobId) this.backgroundJobManager?.trackExecution(backgroundJobId, worker)
      // worker 已将失败写入任务账本；这里记录独立 promise 的收尾，取消路径另等它结束。
      void worker.catch((error) => {
        this.log.debug('子 Agent 后台执行已收尾', { threadId, error: AppError.from(error) })
      })
      return formatSubAgentTaskResultForParent(
        buildSubAgentTaskResult({
          threadId,
          text: formatSubAgentStartedMessage(title, backgroundJobId, dispatchMode),
          status: 'running',
        })
      )
    }

    // sync：阻塞等 runWorker 返回子 Agent 的最终结果并内联返回给父 Agent。
    // 传入 backgroundJobId（非 null），让运行进度照常流入侧边栏 job。
    const worker = this.runWorker({
      request: dispatchRequest,
      autonomousParentCtx,
      typeConfig,
      workerEvents,
      title,
      threadId,
      initialToolCategories,
      priorFindingsBriefing,
      statusBase,
      progress: progressEvaluation,
      dispatchMode,
      resumeBriefing,
      readonlyMode,
      resolvedModel,
      resolvedEffort,
      retryState,
      backgroundJobId,
      progressDigest,
    })
    if (backgroundJobId) this.backgroundJobManager?.trackExecution(backgroundJobId, worker)
    return worker
  }

  private async runWorker(args: {
    request: SubAgentDispatchRequest
    autonomousParentCtx: SubAgentToolContext
    typeConfig: ResolvedSubAgentTypeConfig
    workerEvents: ExecutionEventBusContract
    title: string
    threadId: string
    initialToolCategories: ToolCategoryId[]
    priorFindingsBriefing: Nullable<string>
    statusBase: Omit<WorkerStatusArgs, 'status' | 'summary' | 'error' | 'result'>
    progress: ReturnType<SubAgentProgressLedger['evaluate']> | { kind: 'continue' }
    dispatchMode: 'sync' | 'async'
    /** 续跑时上一次运行的结局；新派为 null。 */
    resumeBriefing: Nullable<SubAgentResumeBriefing>
    readonlyMode: boolean
    resolvedModel: Nullable<string>
    resolvedEffort: Nullable<ThinkingDepth>
    retryState: SubAgentRetryState
    backgroundJobId: Nullable<string>
    progressDigest: SubAgentProgressDigestRecorder
  }): Promise<string> {
    const executionKey = args.statusBase.executionKey
    const semaphore = this.getSemaphore(executionKey)
    let relayHandle: Nullable<SubAgentGuidanceRelayWorkerHandle> = null
    await semaphore.acquire()
    try {
      relayHandle = this.guidanceRelayRegistry.registerWorker({
        executionId: executionKey,
        threadId: args.threadId,
        title: args.title,
        description: args.request.input.description?.trim() || null,
        prompt: args.request.input.prompt,
        agentName: args.statusBase.agentName,
        subagentType: resolveSubAgentTypeKey(args.typeConfig),
      })
      const asyncThreadKey = buildSubAgentAsyncThreadKey(executionKey, args.threadId)
      if (this.cancelledAsyncThreads.delete(asyncThreadKey)) {
        relayHandle.abort('后台子 Agent 作业已取消')
      }
      this.sessionStore.setStatus(args.threadId, 'running')
      emitSubAgentWorkerStatus({ ...args.statusBase, status: 'running', summary: args.title })

      if (args.backgroundJobId && this.backgroundJobManager) {
        const jobId = args.backgroundJobId
        args.progressDigest.bindSink((chunk) =>
          void this.backgroundJobManager?.appendOutput(jobId, chunk)
        )
      }

      const plan: DispatchPlan = {
        request: args.request,
        parentCtx: args.autonomousParentCtx,
        identity: {
          threadId: args.threadId,
          activationId: args.statusBase.activationId,
          title: args.title,
        },
        type: {
          typeConfig: args.typeConfig,
          readonlyMode: args.readonlyMode,
        },
        prompt: {
          toolCategories: args.initialToolCategories,
          priorFindingsBriefing: args.priorFindingsBriefing,
          resumeBriefing: args.resumeBriefing,
        },
        control: {
          workerEvents: args.workerEvents,
          retryState: args.retryState,
          relayHandle,
          resolvedModelOverride: args.resolvedModel,
          resolvedEffortOverride: args.resolvedEffort,
          onTransientRetry: (error, attempt) => {
            emitSubAgentWorkerStatus({
              ...args.statusBase,
              status: 'running',
              summary: formatSubAgentTransientRetryStatus(
                error,
                attempt,
                SubAgentDispatcher.SubAgentTransientRetryMaxAttempts
              ),
              error: error.message,
            })
          },
        },
      }
      const workerOutput = await this.runWithOptionalWriteLease(plan)
      args.request.parentCtx.abortSignal.throwIfAborted()
      relayHandle.abortSignal.throwIfAborted()

      const rawText = workerOutput.text
      const notes = [
        args.progress.kind === 'soft-nudge' ? args.progress.note : null,
        formatModelFallbackNote(workerOutput.modelTrace),
      ].filter(isPresent)
      const decorated = isEmpty(notes) ? rawText : [rawText, ...notes].join('\n\n')
      const taskResult = buildSubAgentTaskResult({
        threadId: args.threadId,
        text: decorated,
        status: 'completed',
        structuredOutput: workerOutput.structuredOutput,
        usage: workerOutput.usage,
        modelTrace: workerOutput.modelTrace,
        retention: this.sessionStore.describeRetention(args.threadId),
      })
      this.sessionStore.appendRunResult(args.threadId, taskResult)
      this.sessionStore.setStatus(args.threadId, 'completed')

      if (!args.resumeBriefing) {
        this.progressLedger.recordFinding(executionKey, {
          type: resolveSubAgentTypeKey(args.typeConfig),
          title: args.title,
          summary: rawText,
        })
      }

      // 先把完整结构化结果写入 job artifact，再发布 terminal worker 事件。
      // 这样 UI/父 Agent 看到 completed 时，job:read_output 已经可读，不存在「先通知后落盘」窗口。
      this.completeSubAgentBackgroundJob(args.backgroundJobId, taskResult)
      emitSubAgentWorkerStatus({
        ...args.statusBase,
        status: 'completed',
        summary: truncate(taskResult.summary.trim(), 200),
        result: taskResult,
      })
      return formatSubAgentTaskResultForParent(taskResult, args.statusBase.agentName)
    } catch (error) {
      const appError = AppError.from(error)
      if (
        appError.code === 'EXECUTION_ABORTED' ||
        args.request.parentCtx.abortSignal.aborted ||
        relayHandle?.abortSignal.aborted
      ) {
        const abortError = appError.code === 'EXECUTION_ABORTED'
          ? appError
          : new AppError('EXECUTION_ABORTED', '子智能体已中断。', error)
        const taskResult = buildSubAgentTaskResult({
          threadId: args.threadId,
          text: '子智能体已中断。',
          status: 'aborted',
          windDownReason: 'user_interrupt',
          retention: this.sessionStore.describeRetention(args.threadId),
        })
        this.sessionStore.appendRunResult(args.threadId, taskResult)
        this.sessionStore.setStatus(args.threadId, 'aborted')
        this.failSubAgentBackgroundJob(args.backgroundJobId, taskResult)
        emitSubAgentWorkerStatus({
          ...args.statusBase,
          status: 'aborted',
          summary: '子智能体已中断。',
          result: taskResult,
        })
        if (args.request.parentCtx.abortSignal.aborted || !relayHandle?.abortSignal.aborted) {
          throw abortError
        }
        return formatSubAgentTaskResultForParent(taskResult, args.statusBase.agentName)
      }

      const message = this.formatWorkerFailureMessage(appError)
      const retention = this.sessionStore.describeRetention(args.threadId)
      const taskResult = buildSubAgentTaskResult({
        threadId: args.threadId,
        text: `${message}\n\n${formatSubAgentFailureRedispatchGuidance(args.threadId, retention.resumable)}`,
        status: 'failed',
        retention,
      })
      this.sessionStore.appendRunResult(args.threadId, taskResult)
      this.sessionStore.setStatus(args.threadId, 'failed')
      this.failSubAgentBackgroundJob(args.backgroundJobId, taskResult)
      emitSubAgentWorkerStatus({
        ...args.statusBase,
        status: 'failed',
        summary: truncate(message, 200),
        error: message,
        result: taskResult,
      })
      return formatSubAgentTaskResultForParent(taskResult, args.statusBase.agentName)
    } finally {
      relayHandle = null
      this.cancelledAsyncThreads.delete(buildSubAgentAsyncThreadKey(executionKey, args.threadId))
      this.guidanceRelayRegistry.unregisterWorker(executionKey, args.threadId)
      semaphore.release()
    }
  }

  private startSubAgentBackgroundJob(args: {
    request: SubAgentDispatchRequest
    executionKey: string
    threadId: string
    title: string
  }): Nullable<string> {
    if (!this.backgroundJobManager) return null

    try {
      const jobId = `${args.threadId}:background:${randomUUID()}`
      const job = this.backgroundJobManager.start({
        id: jobId,
        sessionId: args.request.parentCtx.sessionId,
        kind: 'sub-agent',
        label: args.title,
        // KernelBackgroundJobManager 在把 cancelled 通知/唤醒发出前同步调 onCancel。
        // 先写入完整 aborted envelope，确保主 Agent 被唤醒时 job:read_output 已有终态制品。
        onCancel: () => {
          this.appendCancelledSubAgentArtifact(jobId, args.threadId)
          this.cancelAsyncWorker(args.executionKey, args.threadId)
        },
      })
      return job.id
    } catch (error) {
      this.log.warn('sub-agent background job start failed', AppError.from(error))
      return null
    }
  }

  private completeSubAgentBackgroundJob(
    jobId: Nullable<string>,
    taskResult: SubAgentTaskResult
  ): void {
    if (!jobId || !this.backgroundJobManager) return

    const artifact = this.buildSubAgentBackgroundArtifact(taskResult)
    try {
      this.backgroundJobManager.complete(jobId, {
        result: truncate(taskResult.summary.trim(), 2_000),
        artifact,
      })
    } catch (error) {
      this.log.warn('sub-agent background job completion failed', AppError.from(error))
    }
  }

  private failSubAgentBackgroundJob(
    jobId: Nullable<string>,
    taskResult: SubAgentTaskResult
  ): void {
    if (!jobId || !this.backgroundJobManager) return

    const artifact = this.buildSubAgentBackgroundArtifact(taskResult)
    try {
      this.backgroundJobManager.fail(jobId, {
        error: truncate(taskResult.summary.trim(), 2_000),
        artifact,
      })
    } catch (error) {
      const appError = AppError.from(error)
      // 用户取消后台任务与子 Agent 抛错回灌是两条独立赛道，谁先到不确定：取消先到时这里必然撞
      // 「任务已终态」冲突——那是正常竞态不是故障，不该刷 warn。判据走 code + context.jobStatus
      // （KernelBackgroundJobManager 的结构化契约），**不许 sniff message 文案**：文案一改这条
      // 静默失效，只表现为日志噪音，没有任何门会喊红。
      if (appError.code === 'CONFLICT' && appError.context.jobStatus === 'cancelled') {
        // cancel handler 已在 cancelled 通知前同步写入同等的 aborted envelope；
        // worker 收尾只发布自身 terminal event，不再重复追加同一份制品。
        return
      }
      this.log.warn('sub-agent background job failure update failed', appError)
    }
  }

  private buildSubAgentBackgroundArtifact(taskResult: SubAgentTaskResult): string {
    const formatted = formatSubAgentBackgroundArtifact(taskResult)
    if (formatted.degraded) {
      // structured_output 可能携带不可 JSON 序列化值；artifact 降级成文本摘要，
      // 绝不能反向把已收敛的子 Agent 标成失败。
      this.log.warn(
        'sub-agent background artifact serialization failed',
        AppError.from(formatted.error)
      )
    }
    return formatted.artifact
  }

  private appendCancelledSubAgentArtifact(jobId: string, threadId: string): void {
    if (!this.backgroundJobManager) return

    const taskResult = buildSubAgentTaskResult({
      threadId,
      text: '子智能体已中断。',
      status: 'aborted',
      windDownReason: 'user_interrupt',
      retention: this.sessionStore.describeRetention(threadId),
    })
    try {
      this.backgroundJobManager.appendTerminalArtifact(
        jobId,
        this.buildSubAgentBackgroundArtifact(taskResult)
      )
    } catch (error) {
      this.log.warn('cancelled sub-agent artifact append failed', AppError.from(error))
    }
  }

  private cancelAsyncWorker(executionKey: string, threadId: string): void {
    this.cancelledAsyncThreads.add(buildSubAgentAsyncThreadKey(executionKey, threadId))
    this.abortWorker(executionKey, threadId, '后台子 Agent 作业已取消')
  }

  private handleInterruptDispatch(
    request: SubAgentDispatchRequest,
    executionKey: string,
    threadId: string
  ): string {
    const aborted = this.abortWorker(executionKey, threadId, '子 Agent 已被 agent:dispatch 中断')
    // 别的父会话的线程对本会话等同于不存在。
    const owned =
      this.sessionStore.getSession(threadId)?.parent_session_id === request.parentCtx.sessionId
    const summary = aborted
      ? '已发送中断信号给正在运行的子智能体。'
      : owned
        ? '该子智能体线程当前不在运行中，无需中断。'
        : `未找到子智能体线程 ${threadId}（可能已过期释放，或从未创建），没有需要中断的运行。`

    const taskResult = buildSubAgentTaskResult({
      threadId,
      text: summary,
      status: aborted ? 'aborted' : 'failed',
      retention: owned ? this.sessionStore.describeRetention(threadId) : SubAgentDispatcher.UnavailableThreadRetention,
    })
    if (aborted) {
      this.sessionStore.appendRunResult(threadId, taskResult)
      this.sessionStore.setStatus(threadId, 'aborted')
    }
    return formatSubAgentTaskResultForParent(taskResult)
  }

  private tryResumeExistingSession(
    request: SubAgentDispatchRequest,
    executionKey: string,
    threadId: string,
    dispatchMode: 'sync' | 'async',
    session: NonNullable<ReturnType<SubAgentSessionStore['getSession']>>
  ): Nullable<string> {
    if (this.isWorkerRunning(executionKey, threadId)) {
      const relayed = this.relayGuidance(executionKey, threadId, request.input.prompt)
      const summary = relayed
        ? '已向正在运行的子智能体 relay 追加指令。'
        : '子智能体仍在运行，但 relay 队列不可用。'
      return formatSubAgentTaskResultForParent(
        buildSubAgentTaskResult({
          threadId,
          text: summary,
          status: 'running',
        })
      )
    }

    if (session.status === 'running' || session.status === 'pending') return formatSubAgentTaskResultForParent(
        buildSubAgentTaskResult({
          threadId,
          text: '子智能体正在启动或运行中，请稍后或通过 relay 追加指令。',
          status: 'running',
        })
      )

    return null
  }

  private isWorkerRunning(executionKey: string, threadId: string): boolean {
    return this.guidanceRelayRegistry
      .listActiveWorkers(executionKey)
      .some((worker) => worker.threadId === threadId)
  }

  /** 类型目录与执行解析读取同一供应方；自定义 id 与内置 id 冲突时遵从执行侧内置优先。 */
  public describeDispatchCatalog(): SubAgentDispatchCatalog {
    const types = new Map<string, SubAgentDispatchCatalog['types'][number]>()
    for (const item of this.subAgentTypeProvider.listDescriptors()) {
      const descriptor = this.subAgentTypeProvider.getDescriptor(item.id)
      if (!descriptor) continue
      types.set(descriptor.id, {
        id: descriptor.id,
        description: descriptor.description,
        readonlyDefault: descriptor.readonlyDefault,
      })
    }
    for (const item of this.customAgentRegistry?.listDescriptors() ?? []) {
      if (types.has(item.id)) continue
      const definition = this.customAgentRegistry?.get(item.id)
      if (!definition || !this.subAgentTypeProvider.getDescriptor(definition.base)) continue
      const resolved = resolveCustomSubAgentTypeConfig(this.subAgentTypeProvider, definition)
      types.set(item.id, {
        id: item.id,
        description: definition.description,
        readonlyDefault: resolved.readonlyDefault,
      })
    }
    return { defaultTypeId: this.subAgentTypeProvider.defaultTypeId, types: [...types.values()] }
  }

  private formatUnknownSubagentTypeMessage(requestedType: string): string {
    const catalog = this.describeDispatchCatalog()
    return [
      `未知的 subagent_type："${requestedType}"。`,
      `当前可用类型：${catalog.types.map(({ id }) => id).join(', ')}。`,
      `新建时省略 subagent_type 使用宿主默认类型 ${catalog.defaultTypeId}。`,
      '请改用上述类型之一，或直接自行完成该任务。',
    ].join('\n')
  }

  private formatWorkerFailureMessage(error: AppError): string {
    if (!this.connectionRetryHelper.isTransientConnectionError(error)) return error.message

    return [
      `模型/provider 连接中断（${error.code}）：${error.message}`,
      '安全自动恢复未能完成；这不是子 Agent 时间预算到期，也不是本地取消。',
    ].join('\n')
  }

  /**
   * 父会话被删除时由宿主调用：中断该会话仍在运行的子 Agent，并丢掉它的全部线程（含保留期内的）。
   * 执行作用域的计数、信号量与账本不在这里回收，它们仍随各自执行的 `clearExecution` 走。
   */
  public releaseParentSession(parentSessionId: string): void {
    for (const thread of this.sessionStore.releaseParentSession(parentSessionId)) {
      if (thread.executionId)
        this.abortWorker(thread.executionId, thread.threadId, 'Parent session released')
    }
  }

  /**
   * 顶层执行结束：中断仍在运行的 worker，回收本次执行的计数、信号量与进展账本，避免无界增长。
   * 子 Agent 线程**不删**——脱离执行转入保留期，供同一父会话的后续执行带 thread_id 续跑（见文件头 ④）。
   */
  public clearExecution(executionKey: string): void {
    this.guidanceRelayRegistry.abortAll(executionKey, 'Execution cleared')
    this.dispatchCountByExecution.delete(executionKey)
    this.semaphores.delete(executionKey)
    this.progressLedger.clear(executionKey)
    this.guidanceRelayRegistry.clearExecution(executionKey)
    this.sessionStore.clearExecution(executionKey)
    const prefix = `${executionKey}\u0000`
    for (const threadId of this.cancelledAsyncThreads) {
      if (threadId.startsWith(prefix)) {
        this.cancelledAsyncThreads.delete(threadId)
      }
    }
  }

  private async runWithOptionalWriteLease(
    plan: DispatchPlan
  ): Promise<SubAgentWorkerExecutionOutput> {
    const { request, control, type, identity, prompt } = plan
    const { typeConfig } = type
    const { threadId, title } = identity
    const systemConfig = this.configService.systemConfig
    // 主模型的模型选择（产品自有形状，含 provider/model）——子 Agent 默认就用它。
    const modelSelection =
      request.config.modelSelection ?? this.configService.chatConfig.modelSelection
    const resourceId = toNullable(request.parentCtx.resourceId)
    // 续跑只拼追加任务：首次派发的委派外壳与上下文都在线程历史里（QueryLoop 把它原样接在历史后）。
    const instruction = prompt.resumeBriefing
      ? buildSubAgentResumeInstruction(request.input, prompt.resumeBriefing)
      : buildSubAgentDispatchInstruction(
          request.input,
          typeConfig,
          title,
          prompt.toolCategories,
          prompt.priorFindingsBriefing,
          type.readonlyMode
        )
    const routeCategory = resolveSubAgentRouteCategory(request, typeConfig)
    // 路由端口收的是模型选择本身，不是整份 chatConfig：传整份时两端端口都在根上找不到 provider，
    // 子 Agent 一律报「模型 selection.provider 必须显式提供」。
    const inheritedRoute = this.modelRouter.resolve(
      typeConfig.workerType,
      routeCategory,
      modelSelection,
      systemConfig
    )
    const modelChoice = await this.resolveModelChoice(
      modelSelection,
      control.resolvedModelOverride ?? request.input.model
    )
    const route = applySubAgentEffortOverride(
      applySubAgentModelOverride(inheritedRoute, modelChoice.model),
      control.resolvedEffortOverride ?? request.input.effort
    )
    const resolvedModel = route.runtimeOverride.model
    const modelTrace: TeamModelSelectionTrace = {
      category: routeCategory,
      providerId: route.runtimeOverride.providerId,
      model: resolvedModel,
      reason: modelChoice.reason,
      timestamp: Date.now(),
      metadata: {
        requestedModel: toOptional(modelChoice.requestedModel),
        selectableModels: toOptional(modelChoice.selectableModelIds),
      },
    }
    this.sessionStore.updateSession(threadId, {
      request: {
        model: resolvedModel,
        route_category: resolveSubAgentRouteCategory(request, typeConfig),
      },
    })

    const softDeadlineAt = Date.now() + this.executionLimits.subAgentSoftDeadlineMs
    const initialHistory = this.sessionStore.getHistory(threadId)

    let structuredOutput: unknown
    let usage: SubAgentUsage | undefined
    const resolvedPlan: ResolvedDispatchPlan = {
      ...plan,
      execution: {
        route,
        resolvedModel,
        resourceId,
        instruction,
        softDeadlineAt,
        initialHistory,
        onStructuredOutput: (value) => {
          structuredOutput = value
        },
        onUsage: (value) => {
          usage = value
        },
        onHistoryUpdate: (history) => this.sessionStore.setHistory(threadId, history),
      },
    }
    const rawText = await this.executeWithRoute(resolvedPlan)
    return {
      text: rawText.trim() || '子智能体已完成，但没有返回文本。',
      structuredOutput,
      usage,
      modelTrace,
    }
  }

  /**
   * 子 Agent 用哪个模型：省略 = 沿用主模型；主 Agent 指定时，必须是主模型所在厂商下宿主已配置的模型。
   *
   * 指定值不在可选列表里时**不拒绝派发**，沿用主模型并把可选列表回报给主 Agent（宽容原则：钳制不拒绝）；
   * 宿主不提供目录（自定义厂商接受任意 id）时按原样透传。按 id 精确匹配，也认大小写不同的 id 或展示名。
   */
  private async resolveModelChoice(
    modelSelection: unknown,
    requestedModel: LooseOptional<string>
  ): Promise<SubAgentModelChoice> {
    const requested = requestedModel?.trim()
    const selectable = await this.modelRouter.listSelectableModels(modelSelection)
    const selectableModelIds = selectable
      ?.map((model) => model.id)
      .slice(0, SubAgentDispatcher.MaxReportedSelectableModels)
    if (!requested)
      return {
        model: null,
        reason: 'inherited-main-model',
        selectableModelIds: toOptional(selectableModelIds),
      }
    if (!selectable)
      return { model: requested, reason: 'requested-model', requestedModel: requested }

    const normalized = requested.toLowerCase()
    const match =
      selectable.find((model) => model.id === requested) ??
      selectable.find(
        (model) =>
          model.id.toLowerCase() === normalized || model.label?.trim().toLowerCase() === normalized
      )
    if (match) return { model: match.id, reason: 'requested-model', requestedModel: requested }

    return {
      model: null,
      reason: 'requested-model-unavailable',
      requestedModel: requested,
      selectableModelIds: selectableModelIds ?? [],
    }
  }

  /**
   * 用解析后的派发计划执行一次子智能体；成功/失败时更新 provider 健康度。
   * 注入路由的候选约束失败时可按路由策略放宽一次再试。
   */
  private async executeWithRoute(plan: ResolvedDispatchPlan): Promise<string> {
    const { request, parentCtx, control, execution, type, prompt } = plan
    const { typeConfig } = type
    const { title, threadId } = plan.identity
    const workerAbortSignal = control.relayHandle?.abortSignal
    const effectiveParentCtx = workerAbortSignal
      ? {
          ...parentCtx,
          abortSignal: combineAbortSignals(parentCtx.abortSignal, workerAbortSignal),
        }
      : parentCtx

    const runWithRoute = (route: TeamModelRouteResult): Promise<string> => {
      const runQuery = async (): Promise<string> =>
        this.getAgentRunner().query(execution.instruction, effectiveParentCtx, {
          roleId: typeConfig.roleId,
          toolCategories: prompt.toolCategories,
          allowedTools: !isEmpty(typeConfig.toolNames) ? [...typeConfig.toolNames] : undefined,
          requestToolCategories: (categories, reason) =>
            this.requestToolCategoriesForSubAgent(request, categories, reason),
          runtimeOverride: route.runtimeOverride,
          events: control.workerEvents,
          streamTextDeltas: true,
          identity: title,
          contextEpochScope: threadId,
          context: request.input.description,
          softDeadlineAt: toOptional(execution.softDeadlineAt),
          consumeRelayedGuidance: control.relayHandle?.consumeRelayedGuidance,
          initialHistory: execution.initialHistory,
          onHistoryUpdate: execution.onHistoryUpdate,
          workerAbortSignal,
          structuredOutputContract: request.input.structuredOutputContract,
          onStructuredOutput: execution.onStructuredOutput,
          onUsage: execution.onUsage,
        })

      if (!typeConfig.resourceLeaseScope) return runQuery()
      return this.writeLeaseCoordinator.runWithLease(
        execution.resourceId,
        typeConfig.resourceLeaseScope,
        threadId,
        runQuery
      )
    }

    try {
      const text = await this.runRouteWithTransientRetry(
        plan,
        effectiveParentCtx,
        execution.route,
        runWithRoute
      )
      this.modelRouter.markSuccess(execution.route.runtimeOverride.providerId)
      return text
    } catch (error) {
      const appError = AppError.from(error)
      if (isSubAgentAbortError(appError, effectiveParentCtx)) {
        throw appError
      }
      this.modelRouter.markFailure(execution.route.runtimeOverride.providerId, appError.message)

      const relaxed = this.modelRouter.createRelaxedRoute(
        execution.route,
        appError.message
      )
      if (!relaxed) {
        throw appError
      }

      try {
        const text = await this.runRouteWithTransientRetry(
          plan,
          effectiveParentCtx,
          relaxed,
          runWithRoute
        )
        this.modelRouter.markSuccess(relaxed.runtimeOverride.providerId)
        return text
      } catch (retryError) {
        const retryAppError = AppError.from(retryError)
        if (isSubAgentAbortError(retryAppError, effectiveParentCtx)) {
          throw retryAppError
        }
        this.modelRouter.markFailure(relaxed.runtimeOverride.providerId, retryAppError.message)
        throw retryAppError
      }
    }
  }

  private async runRouteWithTransientRetry(
    plan: ResolvedDispatchPlan,
    effectiveParentCtx: SubAgentToolContext,
    route: TeamModelRouteResult,
    runWithRoute: (route: TeamModelRouteResult) => Promise<string>
  ): Promise<string> {
    let lastError: Nullable<AppError> = null

    for (let attempt = 1; attempt <= SubAgentDispatcher.SubAgentTransientRetryMaxAttempts; attempt += 1) {
      try {
        return await runWithRoute(route)
      } catch (error) {
        const appError = AppError.from(error)
        if (isSubAgentAbortError(appError, effectiveParentCtx)) throw appError

        lastError = appError
        if (!this.shouldRetrySubAgentConnectionError(appError, attempt, plan, effectiveParentCtx)) {
          throw appError
        }

        plan.control.onTransientRetry?.(appError, attempt)
      }
    }

    throw lastError ?? new AppError('NETWORK', '子智能体网络重试失败。')
  }

  private shouldRetrySubAgentConnectionError(
    error: AppError,
    attempt: number,
    plan: ResolvedDispatchPlan,
    effectiveParentCtx: SubAgentToolContext
  ): boolean {
    if (attempt >= SubAgentDispatcher.SubAgentTransientRetryMaxAttempts) return false
    return this.connectionRetryHelper.shouldRetryConnectionError(error, attempt, {
      abortSignal: effectiveParentCtx.abortSignal,
      hasToolUse: () => plan.control.retryState.hasToolUse,
      hasVisibleOutput: () => plan.control.retryState.hasVisibleOutput,
    })
  }

  private async requestToolCategoriesForSubAgent(
    request: SubAgentDispatchRequest,
    categories: ToolCategoryId[],
    reason: string
  ): Promise<SubAgentToolCategoryRequestResult> {
    const expandedRequest = dedupeToolCategories(categories)
    const blockedCategories = expandedRequest.filter((categoryId) =>
      this.isBlockedToolCategory(categoryId)
    )
    const requestedCategories = expandedRequest.filter(
      (categoryId) => !this.isBlockedToolCategory(categoryId)
    )
    const enabledBefore = request.parentCtx.codingSession.getEnabledToolCategories()

    if (isEmpty(requestedCategories)) return {
        enabled: false,
        approved: false,
        reason,
        requestedCategories: expandedRequest,
        enabledCategories: enabledBefore,
        skippedCategories: expandedRequest,
        message: isEmpty(blockedCategories)
          ? '没有可为子智能体开放的工具分类。'
          : `子智能体不开放这些工具分类：${blockedCategories.join(', ')}。请主智能体自行使用，或改派不依赖这些能力的子任务。`,
      }

    // 能力请求只决定子 Agent 的可用面；LoopRuntime 在子 tracker 上完成启用。
    // 工具执行时仍走同一个任务审批端口。
    return {
      enabled: true,
      approved: true,
      autoApproved: true,
      reason,
      requestedCategories: expandedRequest,
      enabledCategories: requestedCategories,
      skippedCategories: blockedCategories,
      message: '这些工具分类可供当前子 Agent 使用；操作授权仍按任务策略判断。',
    }
  }

  private isBlockedToolCategory(categoryId: ToolCategoryId): boolean {
    return resolveCapabilityDelegationPolicy(this.capabilityPorts).blockedCategoryIds.includes(
      categoryId
    )
  }

}

export { resolveSubAgentExecutionKey, SubAgentDispatcher }

/** 建一台子 Agent 派发器：并发闸、类型路由、模型路由与写租约都在它身上。 */
export function createSubAgentDispatcher(modelRouter: TeamModelRouterApi, writeLeaseCoordinator: WriteLeaseCoordinatorApi, configService: SubAgentConfigPort, guidanceRelayRegistry: SubAgentGuidanceRelayRegistryApi, subAgentTypeProvider: SubAgentTypeProvider, capabilityPorts?: AgentRuntimeCapabilityPorts, backgroundJobManager?: KernelBackgroundJobManagerApi, customAgentRegistry?: CustomSubAgentRegistry, executionLimitOverrides: AgentExecutionLimitOverrides = {}): SubAgentDispatcherApi {
  return new SubAgentDispatcher(modelRouter, writeLeaseCoordinator, configService, guidanceRelayRegistry, subAgentTypeProvider, capabilityPorts, backgroundJobManager, customAgentRegistry, executionLimitOverrides)
}
