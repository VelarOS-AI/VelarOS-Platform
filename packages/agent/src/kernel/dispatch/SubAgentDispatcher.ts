// 域：按需子 Agent **派发决策与运行编排**（并发闸/熔断闸解析、类型路由、模型路由健康度反馈、
// 写租约、沙箱作用域、worker 事件投影、失败/中断回灌）。
//
// 本体 host 无关，只认端口不认实现（见 ./host-ports）：Desktop 在 execution/Runtime.ts 注入具体
// AgentRunner / ConfigService / 协作协调器 / 自定义 agent 注册表——它们结构上满足端口。文案格式化见
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
// `validateResumeIdentity` 逐项比对 execution / parent session / 类型 / 自定义 agent id / readonly /
// tool_scope / 工具分类集合 / model / route_category。判据：续跑 = **复用一段既有对话历史**，任何一项
// 不一致都意味着这段历史是在另一套前提下产生的，接着跑会让模型带着错误前提工作——那类错误既不报错也
// 不好查。失败方向选「拒绝并要求新派」。
import { randomUUID } from 'node:crypto'

import type { ModelMessage } from 'ai'

import { isBoolean, isEmpty, isFunction, Log, optionalWhen, toNullable,toOptional, truncate } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { createUnattendedSubAgentApprovalPort } from '@velaros-ai/core/tool-contract'
import type {
  AgentEvent,
  ExecutionTaskStatus,
  SubAgentTaskResult,
  SubAgentUsage,
  TeamModelRouteCategory,
  ThinkingDepth,
  ToolCategoryId,
  UserActionCard,
} from '@velaros-ai/core/types'

import {
  type AgentExecutionLimitOverrides,
  type AgentExecutionLimits,
  resolveAgentExecutionLimits,
} from '../../agent/ExecutionLimits'
import { AgentConnectionRetryHelper } from '../../agent/retry'
import type {
  AgentExecutionConfig,
} from '../../agent/RuntimeConfiguration'
import {
  type AgentRuntimeCapabilityPorts,
  resolveCapabilityDelegationPolicy,
} from '../../capabilities'
import {
  type SubAgentGuidanceRelayRegistry,
  type SubAgentGuidanceRelayWorkerHandle,
} from '../../execution'
import {
  buildSubAgentTaskResult,
  preCheckSubAgentDispatch,
  resolveCustomSubAgentTypeConfig,
  type ResolvedSubAgentTypeConfig,
  resolveReadonlyMode,
  resolveSubAgentTypeConfig,
  SubAgentSessionStore,
  type SubAgentTypeProvider,
} from '../../sub-agent'
import {
  type TeamModelRouter,
  type TeamModelRouteResult,
  type WriteLeaseCoordinator,
} from '../../team'
import type { KernelBackgroundJobManager } from '../background-jobs'
import type { ExecutionEventBus } from '../execution/ExecutionEventBus'

import { Semaphore } from './concurrency'
import {
  type CustomSubAgentRegistry,
  type SubAgentConfigPort,
  type SubAgentDispatchInput,
  type SubAgentQueryRunner,
  type SubAgentToolCategoryRequestResult,
  type SubAgentToolContext,
} from './host-ports'
import { buildSubAgentDispatchInstruction } from './instruction'
import {
  formatSubAgentFailureRedispatchGuidance,
  formatSubAgentHighRiskConfirmationStatus,
  formatSubAgentStartedMessage,
  formatSubAgentTaskResultForParent,
  resolveSubAgentAgentName,
} from './result-format'
import { SubAgentProgressDigestRecorder } from './SubAgentProgressDigest'
import { SubAgentProgressLedger } from './SubAgentProgressLedger'

interface SubAgentDispatchRequest {
  input: SubAgentDispatchInput
  parentCtx: SubAgentToolContext
  events: ExecutionEventBus
  config: AgentExecutionConfig
}

/** 派发身份分片：一次子 Agent 运行的稳定标识。 */
interface DispatchIdentityScope {
  threadId: string
  activationId: string
  title: string
}

/** 派发类型分片：解析后的类型配置与只读模式。 */
interface DispatchTypeScope {
  typeConfig: ResolvedSubAgentTypeConfig
  readonlyMode: boolean
}

/** 派发提示分片：拼装子 Agent 指令所需的输入。 */
interface DispatchPromptScope {
  toolCategories: ToolCategoryId[]
  priorFindingsBriefing: Nullable<string>
}

/** 派发控制分片：运行编排所需的事件面 / 重试 / 中继 / 模型覆盖 / effort 覆盖。 */
interface DispatchControlScope {
  workerEvents: ExecutionEventBus
  retryState: SubAgentRetryState
  relayHandle: Nullable<SubAgentGuidanceRelayWorkerHandle>
  resolvedModelOverride: Nullable<string>
  /** reasoning effort 覆盖（D7）；null 表示继承会话 effort（由模型路由填 systemConfig.thinkingDepth）。 */
  resolvedEffortOverride: Nullable<ThinkingDepth>
  onTransientRetry?: (error: AppError, attempt: number) => void
}

/**
 * 派发计划：一次子 Agent 派发的全部输入，**按域分片**，由 runWorker 构造一次、贯穿写租约与路由
 * 执行全链（宪章 §12.7「两表示最多一个转换器」/ §12.8「对象按域分片」）。取代旧
 * `runWithOptionalWriteLease` 14 位置参数列 → `ExecuteWorkerRouteArgs` re-bag → `ExecuteWithRouteArgs`
 * 摊平的三态转换链。
 */
interface DispatchPlan {
  request: SubAgentDispatchRequest
  /** 已通过父线程授权、运行期自动放行确认的工具上下文（尚未做沙箱作用域）。 */
  parentCtx: SubAgentToolContext
  identity: DispatchIdentityScope
  type: DispatchTypeScope
  prompt: DispatchPromptScope
  control: DispatchControlScope
}

/**
 * 执行相位分片：路由解析时一次性派生的字段（路由 / 已解析模型 / 资源作用域 / 指令 / 软上限 /
 * 续跑历史 / 输出汇）。由 runWithOptionalWriteLease（**唯一转换器**）解析后附加到派发计划。
 */
interface DispatchExecutionScope {
  route: TeamModelRouteResult
  resolvedModel: Nullable<string>
  resourceId: Nullable<string>
  instruction: string
  /** 子智能体软上限时间戳（毫秒）；到点收尾返回而非硬杀。null 表示不施加时间上限。 */
  softDeadlineAt: Nullable<number>
  initialHistory: ModelMessage[]
  onStructuredOutput: (value: unknown) => void
  onUsage: (usage: SubAgentUsage) => void
  onHistoryUpdate: (history: ModelMessage[]) => void
}

/**
 * 解析后的派发计划：基础计划 + 沙箱作用域后的 `parentCtx` + 执行相位分片。是
 * executeWithRoute / 瞬态重试相位的唯一入参。
 */
interface ResolvedDispatchPlan extends DispatchPlan {
  execution: DispatchExecutionScope
}

interface WorkerStatusArgs {
  request: SubAgentDispatchRequest
  threadId: string
  activationId: string
  executionKey: string
  title: string
  agentName: string
  typeConfig: ResolvedSubAgentTypeConfig
  status: ExecutionTaskStatus
  dispatchMode: 'sync' | 'async'
  resolvedModel?: LooseOptional<string>
  result?: SubAgentTaskResult
  summary?: string
  error?: string
}

interface SubAgentRetryState {
  hasVisibleOutput: boolean
  hasToolUse: boolean
}

interface SubAgentWorkerExecutionOutput {
  text: string
  structuredOutput?: unknown
  usage?: SubAgentUsage
}

type DangerousConfirmationStatusSink = (
  status: Extract<ExecutionTaskStatus, 'awaiting_confirmation' | 'running'>,
  summary: string
) => void

const SubAgentTransientRetryMaxAttempts = 2
const DefaultMaxConcurrentSubAgents = 4
const DefaultMaxSubAgentsPerExecution = 32

function normalizeResumeIdentityString(value: LooseOptional<string>): string {
  return value?.trim() ?? ''
}

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

/** 工具分类去重（保序）。只做去重——不做展开、不做只读收窄，那两件事分别归类型配置与执行门。 */
function dedupeToolCategories(categories: readonly ToolCategoryId[]): ToolCategoryId[] {
  return [...new Set<ToolCategoryId>(categories)]
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}

/**
 * 按需子智能体派发器。
 *
 * 主智能体通过 agent:dispatch 工具触发；负责并发上界（按执行隔离）、类型路由、
 * 模型路由健康度反馈、写租约、工作线程事件投影，以及失败/中断的回灌处理。
 */
class SubAgentDispatcher {
  /** 每个顶层执行独立的并发信号量，避免跨会话/窗口互相阻塞排队。 */
  private readonly semaphores = new Map<string, Semaphore>()
  private readonly dispatchCountByExecution = new Map<string, number>()
  /** 派发进展账本：无进展熔断（A）+ 跨派发发现复用（B），按执行隔离。 */
  private readonly progressLedger = new SubAgentProgressLedger()
  private readonly sessionStore = new SubAgentSessionStore()
  private readonly connectionRetryHelper = new AgentConnectionRetryHelper()
  private readonly cancelledAsyncThreads = new Set<string>()
  private readonly log = Log.tag('SubAgentDispatcher')
  private agentRunner: Nullable<SubAgentQueryRunner> = null
  private readonly executionLimits: AgentExecutionLimits

  constructor(
    private readonly modelRouter: TeamModelRouter,
    private readonly writeLeaseCoordinator: WriteLeaseCoordinator,
    private readonly configService: SubAgentConfigPort,
    private readonly guidanceRelayRegistry: SubAgentGuidanceRelayRegistry,
    private readonly subAgentTypeProvider: SubAgentTypeProvider,
    private readonly capabilityPorts?: AgentRuntimeCapabilityPorts,
    private readonly backgroundJobManager?: KernelBackgroundJobManager,
    private readonly customAgentRegistry?: CustomSubAgentRegistry,
    executionLimitOverrides: AgentExecutionLimitOverrides = {}
  ) {
    this.executionLimits = resolveAgentExecutionLimits(executionLimitOverrides)
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

  /** 取得（或惰性创建）某次执行的并发信号量；上限取配置（advancedRuntime.maxConcurrentSubAgents）。 */
  private getSemaphore(executionKey: string): Semaphore {
    const existing = this.semaphores.get(executionKey)
    if (existing) return existing
    const limit =
      this.configService.systemConfig.advancedRuntime?.maxConcurrentSubAgents ??
      DefaultMaxConcurrentSubAgents
    const created = new Semaphore(limit)
    this.semaphores.set(executionKey, created)
    return created
  }

  public abortWorker(executionKey: string, threadId: string, reason?: string): boolean {
    return this.guidanceRelayRegistry.abortWorker(executionKey, threadId, reason)
  }

  public relayGuidance(executionKey: string, threadId: string, message: string): boolean {
    return this.guidanceRelayRegistry.enqueueRelay(executionKey, threadId, message)
  }

  public async dispatch(request: SubAgentDispatchRequest): Promise<string> {
    const executionKey = resolveSubAgentExecutionKey({
      executionId: request.config.execution?.executionId,
      sessionId: request.parentCtx.sessionId,
    })
    const dispatchMode = request.input.mode ?? 'sync'
    const requestedThreadId = request.input.threadId?.trim()

    if (requestedThreadId && request.input.interrupt)
      return this.handleInterruptDispatch(request, executionKey, requestedThreadId)

    const existingSession = requestedThreadId
      ? this.sessionStore.getSession(requestedThreadId)
      : null
    const isResume = !!existingSession

    const dispatchRequest = isResume
      ? this.buildResumeDispatchRequest(request, existingSession!)
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
    const typeConfig = this.resolveEffectiveTypeConfig(baseTypeConfig, readonlyMode)
    const initialToolCategories = this.resolveInitialToolCategories(dispatchRequest, typeConfig)

    if (isResume && requestedThreadId) {
      const resumeIdentityError = this.validateResumeIdentity(
        dispatchRequest,
        executionKey,
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
    }

    if (!isResume) {
      const preCheck = preCheckSubAgentDispatch({
        prompt: dispatchRequest.input.prompt,
        subagent_type: subagentType,
        thread_id: requestedThreadId,
      })
      if (!preCheck.allow) {
        const text = [
          '已跳过本次子智能体派发：任务过于简单，建议主 Agent 直接完成。',
          preCheck.reason ? `原因：${preCheck.reason}` : null,
          preCheck.suggestedAction ? `建议：${preCheck.suggestedAction}` : null,
        ]
          .filter(Boolean)
          .join('\n')
        return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: requestedThreadId ?? `subagent:${randomUUID()}`,
            text,
            status: 'failed',
          })
        )
      }
    }

    const title =
      dispatchRequest.input.description?.trim() ||
      truncate(dispatchRequest.input.prompt.trim(), 80) ||
      `${typeConfig.subagentType} sub-agent`

    const signature = this.progressLedger.buildSignature(
      this.resolveTypeKey(typeConfig),
      dispatchRequest.input.prompt,
      dispatchRequest.input.description
    )
    let progressEvaluation: ReturnType<SubAgentProgressLedger['evaluate']> | { kind: 'continue' } =
      { kind: 'continue' }

    if (!isResume) {
      progressEvaluation = this.progressLedger.evaluate(executionKey, signature)
      if (progressEvaluation.kind === 'hard-stop') return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: requestedThreadId ?? `subagent:${randomUUID()}`,
            text: `已跳过本次子智能体派发：${progressEvaluation.note}`,
            status: 'failed',
          })
        )

      const used = this.dispatchCountByExecution.get(executionKey) ?? 0
      if (used >= DefaultMaxSubAgentsPerExecution) return formatSubAgentTaskResultForParent(
          buildSubAgentTaskResult({
            threadId: requestedThreadId ?? `subagent:${randomUUID()}`,
            text: `本次执行已达到子智能体派发上限（${DefaultMaxSubAgentsPerExecution}）。请直接完成剩余工作或合并任务。`,
            status: 'failed',
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
    const workerEvents = this.attachWorkerProbes(
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

    this.emitWorkerStatus({ ...statusBase, status: 'pending', summary: title })

    const autonomousParentCtx = this.buildAutonomousParentCtx(
      dispatchRequest.parentCtx,
      (status, summary) => {
        this.emitWorkerStatus({ ...statusBase, status, summary })
        if (status === 'awaiting_confirmation') {
          this.emitDangerousConfirmationWorkerCard({ ...statusBase, summary })
        }
      }
    )

    if (isResume) {
      this.sessionStore.updateSession(threadId, {
        status: 'running',
        request: {
          prompt: dispatchRequest.input.prompt,
          description: dispatchRequest.input.description,
          mode: dispatchMode,
          readonly: readonlyMode,
        },
      })
    } else {
      this.sessionStore.createSession({
        threadId,
        executionId: executionKey,
        parentSessionId: dispatchRequest.parentCtx.sessionId,
        subagentType: typeConfig.subagentType,
        prompt: dispatchRequest.input.prompt,
        description: dispatchRequest.input.description,
        mode: dispatchMode,
        readonly: readonlyMode,
        toolScope: dispatchRequest.input.toolScope ?? 'type_default',
        toolCategories: initialToolCategories,
        model: resolvedModel,
        routeCategory: this.resolveRouteCategory(dispatchRequest, typeConfig),
        agentName,
        request: { custom_agent_id: toNullable(typeConfig.customAgentId) },
      })
    }

    if (!isResume) {
      this.progressLedger.recordDispatch(executionKey, signature)
    }
    const priorFindingsBriefing = this.progressLedger.buildPriorFindingsBriefing(executionKey)

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
      void this.runWorker({
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
        isResume,
        readonlyMode,
        resolvedModel,
        resolvedEffort,
        retryState,
        backgroundJobId,
        progressDigest,
        // arch-guard:silent-catch-ok async 派发 fire-and-forget：runWorker 内部已捕获并记录全部失败（emitWorkerStatus / failSubAgentBackgroundJob），此处仅防未处理拒绝。
      }).catch(() => undefined)
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
    return this.runWorker({
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
      isResume,
      readonlyMode,
      resolvedModel,
      resolvedEffort,
      retryState,
      backgroundJobId,
      progressDigest,
    })
  }

  private async runWorker(args: {
    request: SubAgentDispatchRequest
    autonomousParentCtx: SubAgentToolContext
    typeConfig: ResolvedSubAgentTypeConfig
    workerEvents: ExecutionEventBus
    title: string
    threadId: string
    initialToolCategories: ToolCategoryId[]
    priorFindingsBriefing: Nullable<string>
    statusBase: Omit<WorkerStatusArgs, 'status' | 'summary' | 'error' | 'result'>
    progress: ReturnType<SubAgentProgressLedger['evaluate']> | { kind: 'continue' }
    dispatchMode: 'sync' | 'async'
    isResume: boolean
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
        subagentType: this.resolveTypeKey(args.typeConfig),
      })
      const asyncThreadKey = this.asyncThreadKey(executionKey, args.threadId)
      if (this.cancelledAsyncThreads.delete(asyncThreadKey)) {
        relayHandle.abort('Background sub-agent job cancelled')
      }
      this.sessionStore.setStatus(args.threadId, 'running')
      this.emitWorkerStatus({ ...args.statusBase, status: 'running', summary: args.title })

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
        },
        control: {
          workerEvents: args.workerEvents,
          retryState: args.retryState,
          relayHandle,
          resolvedModelOverride: args.resolvedModel,
          resolvedEffortOverride: args.resolvedEffort,
          onTransientRetry: (error, attempt) => {
            this.emitWorkerStatus({
              ...args.statusBase,
              status: 'running',
              summary: this.formatTransientRetryStatus(error, attempt),
              error: error.message,
            })
          },
        },
      }
      const workerOutput = await this.runWithOptionalWriteLease(plan)

      const rawText = workerOutput.text
      const decorated =
        args.progress.kind === 'soft-nudge' ? `${rawText}\n\n${args.progress.note}` : rawText
      const taskResult = buildSubAgentTaskResult({
        threadId: args.threadId,
        text: decorated,
        status: 'completed',
        structuredOutput: workerOutput.structuredOutput,
        usage: workerOutput.usage,
      })
      this.sessionStore.appendRunResult(args.threadId, taskResult)
      this.sessionStore.setStatus(args.threadId, 'completed')

      if (!args.isResume) {
        this.progressLedger.recordFinding(executionKey, {
          type: this.resolveTypeKey(args.typeConfig),
          title: args.title,
          summary: rawText,
        })
      }

      this.emitWorkerStatus({
        ...args.statusBase,
        status: 'completed',
        summary: truncate(taskResult.summary.trim(), 200),
        result: taskResult,
      })
      this.completeSubAgentBackgroundJob(args.backgroundJobId, taskResult.summary)
      return formatSubAgentTaskResultForParent(taskResult, args.statusBase.agentName)
    } catch (error) {
      const appError = AppError.from(error)
      if (appError.code === 'EXECUTION_ABORTED') {
        const taskResult = buildSubAgentTaskResult({
          threadId: args.threadId,
          text: '子智能体已中断。',
          status: 'aborted',
          windDownReason: 'user_interrupt',
        })
        this.sessionStore.appendRunResult(args.threadId, taskResult)
        this.sessionStore.setStatus(args.threadId, 'aborted')
        this.emitWorkerStatus({
          ...args.statusBase,
          status: 'aborted',
          summary: '子智能体已中断。',
          result: taskResult,
        })
        this.failSubAgentBackgroundJob(args.backgroundJobId, '子智能体已中断。')
        if (args.request.parentCtx.abortSignal.aborted || !relayHandle?.abortSignal.aborted) {
          throw appError
        }
        return formatSubAgentTaskResultForParent(taskResult, args.statusBase.agentName)
      }

      const message = this.formatWorkerFailureMessage(appError)
      const taskResult = buildSubAgentTaskResult({
        threadId: args.threadId,
        text: `${message}\n\n${formatSubAgentFailureRedispatchGuidance(args.threadId)}`,
        status: 'failed',
      })
      this.sessionStore.appendRunResult(args.threadId, taskResult)
      this.sessionStore.setStatus(args.threadId, 'failed')
      this.emitWorkerStatus({
        ...args.statusBase,
        status: 'failed',
        summary: truncate(message, 200),
        error: message,
        result: taskResult,
      })
      this.failSubAgentBackgroundJob(args.backgroundJobId, message)
      return formatSubAgentTaskResultForParent(taskResult, args.statusBase.agentName)
    } finally {
      relayHandle = null
      this.cancelledAsyncThreads.delete(this.asyncThreadKey(executionKey, args.threadId))
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
      const job = this.backgroundJobManager.start({
        id: `${args.threadId}:background:${randomUUID()}`,
        sessionId: args.request.parentCtx.sessionId,
        kind: 'sub-agent',
        label: args.title,
        onCancel: () => this.cancelAsyncWorker(args.executionKey, args.threadId),
      })
      return job.id
    } catch (error) {
      this.log.warn('sub-agent background job start failed', AppError.from(error))
      return null
    }
  }

  private completeSubAgentBackgroundJob(jobId: Nullable<string>, summary: string): void {
    if (!jobId || !this.backgroundJobManager) return

    try {
      this.backgroundJobManager.complete(jobId, { result: truncate(summary.trim(), 2_000) })
    } catch (error) {
      this.log.warn('sub-agent background job completion failed', AppError.from(error))
    }
  }

  private failSubAgentBackgroundJob(jobId: Nullable<string>, errorMessage: string): void {
    if (!jobId || !this.backgroundJobManager) return

    try {
      this.backgroundJobManager.fail(jobId, { error: truncate(errorMessage.trim(), 2_000) })
    } catch (error) {
      const appError = AppError.from(error)
      // 用户取消后台任务与子 Agent 抛错回灌是两条独立赛道，谁先到不确定：取消先到时这里必然撞
      // 「任务已终态」冲突——那是正常竞态不是故障，不该刷 warn。判据走 code + context.jobStatus
      // （KernelBackgroundJobManager 的结构化契约），**不许 sniff message 文案**：文案一改这条
      // 静默失效，只表现为日志噪音，没有任何门会喊红。
      if (appError.code === 'CONFLICT' && appError.context.jobStatus === 'cancelled') return
      this.log.warn('sub-agent background job failure update failed', appError)
    }
  }

  private cancelAsyncWorker(executionKey: string, threadId: string): void {
    this.cancelledAsyncThreads.add(this.asyncThreadKey(executionKey, threadId))
    this.abortWorker(executionKey, threadId, 'Background sub-agent job cancelled')
  }

  private asyncThreadKey(executionKey: string, threadId: string): string {
    return `${executionKey}\u0000${threadId}`
  }

  private handleInterruptDispatch(
    request: SubAgentDispatchRequest,
    executionKey: string,
    threadId: string
  ): string {
    const aborted = this.abortWorker(executionKey, threadId, 'Sub-agent interrupted via agent:dispatch')
    const session = this.sessionStore.getSession(threadId)
    const summary = aborted
      ? '已发送中断信号给正在运行的子智能体。'
      : session
        ? '该子智能体线程当前不在运行中。'
        : '未找到该子智能体线程。'

    const taskResult = buildSubAgentTaskResult({
      threadId,
      text: summary,
      status: aborted ? 'aborted' : 'failed',
    })
    if (aborted) {
      this.sessionStore.appendRunResult(threadId, taskResult)
      this.sessionStore.setStatus(threadId, 'aborted')
    }
    return formatSubAgentTaskResultForParent(taskResult)
  }

  private buildResumeDispatchRequest(
    request: SubAgentDispatchRequest,
    session: NonNullable<ReturnType<SubAgentSessionStore['getSession']>>
  ): SubAgentDispatchRequest {
    const storedRequest = session.request
    const storedToolCategories = storedRequest.tool_categories
      ? [...storedRequest.tool_categories]
      : undefined
    const storedReadonly = optionalWhen(isBoolean, storedRequest.readonly)
    return {
      ...request,
      input: {
        ...request.input,
        // 自定义 agent 会话续跑时优先还原 custom id（stored subagent_type 只是它的 base）。
        subagentType:
          request.input.subagentType ??
          toOptional(storedRequest.custom_agent_id) ??
          storedRequest.subagent_type,
        toolScope: request.input.toolScope ?? storedRequest.tool_scope ?? 'type_default',
        toolCategories: request.input.toolCategories ?? storedToolCategories,
        readonly: isBoolean(request.input.readonly)
          ? request.input.readonly
          : storedReadonly,
        model: request.input.model ?? toOptional(storedRequest.model),
        routeCategory: request.input.routeCategory ?? toOptional(storedRequest.route_category),
      },
    }
  }

  private validateResumeIdentity(
    request: SubAgentDispatchRequest,
    executionKey: string,
    threadId: string,
    session: NonNullable<ReturnType<SubAgentSessionStore['getSession']>>,
    typeConfig: ResolvedSubAgentTypeConfig,
    readonlyMode: boolean,
    toolCategories: readonly ToolCategoryId[]
  ): Nullable<string> {
    const reject = (reason: string): string =>
      `不能续跑子智能体 ${threadId}：${reason}。请新派发一个子 Agent。`

    if (session.execution_id !== executionKey) return reject(
        `threadId 属于 execution "${session.execution_id}"，当前 execution 是 "${executionKey}"`
      )

    if (session.parent_session_id !== request.parentCtx.sessionId) return reject(
        `threadId 属于 parent session "${session.parent_session_id}"，当前 parent session 是 "${request.parentCtx.sessionId}"`
      )

    if (session.subagent_type !== typeConfig.subagentType) return reject(
        `threadId 属于 sub-agent type "${session.subagent_type}"，当前请求是 "${typeConfig.subagentType}"`
      )

    const storedCustomAgentId = toNullable(session.request.custom_agent_id)
    const currentCustomAgentId = toNullable(typeConfig.customAgentId)
    if (storedCustomAgentId !== currentCustomAgentId) return reject(
        `threadId 属于自定义 agent "${storedCustomAgentId ?? '（无）'}"，当前请求是 "${currentCustomAgentId ?? '（无）'}"`
      )

    if (session.status === 'failed' || session.status === 'aborted') return reject(
        `threadId 已处于 ${session.status} 状态，不能复用不完整的子智能体上下文`
      )

    const storedRequest = session.request
    const storedReadonly = isBoolean(storedRequest.readonly)
      ? storedRequest.readonly
      : typeConfig.readonlyDefault
    if (storedReadonly !== readonlyMode) return reject(
        `threadId 的 readonly=${storedReadonly}，当前请求 readonly=${readonlyMode}`
      )

    const storedToolScope = storedRequest.tool_scope ?? 'type_default'
    const currentToolScope = request.input.toolScope ?? 'type_default'
    if (storedToolScope !== currentToolScope) return reject(
        `threadId 使用 tool_scope "${storedToolScope}"，当前请求是 "${currentToolScope}"`
      )

    const storedToolCategories = storedRequest.tool_categories ?? []
    if (!sameStringSet(storedToolCategories, toolCategories)) return reject(
        `threadId 使用工具分类 "${storedToolCategories.join(', ')}"，当前请求是 "${toolCategories.join(', ')}"`
      )

    const storedModel = normalizeResumeIdentityString(storedRequest.model)
    const currentModel = normalizeResumeIdentityString(request.input.model)
    if (storedModel !== currentModel) return reject(
        `threadId 使用 model "${storedModel || 'default'}"，当前请求是 "${currentModel || 'default'}"`
      )

    const storedRouteCategory = storedRequest.route_category ?? typeConfig.routeCategory
    const currentRouteCategory = this.resolveRouteCategory(request, typeConfig)
    if (storedRouteCategory !== currentRouteCategory) return reject(
        `threadId 使用 route_category "${storedRouteCategory}"，当前请求是 "${currentRouteCategory}"`
      )

    return null
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

  private resolveEffectiveTypeConfig(
    base: ResolvedSubAgentTypeConfig,
    readonlyMode: boolean
  ): ResolvedSubAgentTypeConfig {
    if (!readonlyMode) return base
    return { ...base, resourceLeaseScope: null }
  }

  /** 派发时展示/记账用的类型键：自定义 agent 用其 id，内置类型用类型名。 */
  private resolveTypeKey(typeConfig: ResolvedSubAgentTypeConfig): string {
    return typeConfig.customAgentId ?? typeConfig.subagentType
  }

  private formatUnknownSubagentTypeMessage(requestedType: string): string {
    const customIds = (this.customAgentRegistry?.listDescriptors() ?? []).map(
      (descriptor) => descriptor.id
    )
    return [
      `未知的 subagent_type："${requestedType}"。`,
      `已注入类型：${this.subAgentTypeProvider
        .listDescriptors()
        .map((descriptor) => descriptor.id)
        .join(', ')}。`,
      isEmpty(customIds)
        ? '当前没有已安装的自定义子智能体。'
        : `已安装的自定义子智能体：${customIds.join(', ')}。`,
      '请改用上述类型之一，或直接自行完成该任务。',
    ].join('\n')
  }

  private resolveRouteCategory(
    request: SubAgentDispatchRequest,
    typeConfig: ResolvedSubAgentTypeConfig
  ): TeamModelRouteCategory {
    return request.input.routeCategory ?? typeConfig.routeCategory
  }

  private applyModelOverride(
    route: TeamModelRouteResult,
    modelOverride: LooseOptional<string>
  ): TeamModelRouteResult {
    const normalized = modelOverride?.trim()
    if (!normalized) return route
    return {
      ...route,
      runtimeOverride: {
        ...route.runtimeOverride,
        model: normalized,
      },
    }
  }

  /**
   * reasoning effort 覆盖（D7）：把派发面指定的 effort 覆盖进 runtimeOverride.thinkingDepth，
   * 该字段被 QueryLoop 用于 createAgentProvider / buildSystemPrompt。缺省（null/undefined）时
   * 保留模型路由已填的 systemConfig.thinkingDepth（= 继承会话 effort），不改行为。
   */
  private applyEffortOverride(
    route: TeamModelRouteResult,
    effortOverride: LooseOptional<ThinkingDepth>
  ): TeamModelRouteResult {
    if (!effortOverride) return route
    return {
      ...route,
      runtimeOverride: {
        ...route.runtimeOverride,
        thinkingDepth: effortOverride,
      },
    }
  }

  /**
   * 合并父线程与 worker 中断信号为一个复合信号。
   *
   * 用 `AbortSignal.any()`（Node 20.3+/Electron 已达，全仓首次引入）替代手写
   * `addEventListener('abort', …, {once})`：原生复合信号**弱引用**持有源信号，复合信号被 GC
   * 时监听自动摘除，不会往长命的父 execution 信号上每次派发净增一个从不摘除的监听器
   * （S5 监听器泄漏根治，对照 SoloExecutionService.bindAbortSignal 的 unbind 先例——此处用
   * 原生弱引用语义免去手动 dispose）。已中断的源仍原样透传其 reason。
   */
  private combineAbortSignals(
    parentSignal: AbortSignal,
    workerSignal?: AbortSignal
  ): AbortSignal {
    if (!workerSignal) return parentSignal
    return AbortSignal.any([parentSignal, workerSignal])
  }

  private attachWorkerProbes(
    workerEvents: ExecutionEventBus,
    retryState: SubAgentRetryState,
    progressDigest: SubAgentProgressDigestRecorder
  ): ExecutionEventBus {
    if (!isFunction(workerEvents.withAgentTap)) return workerEvents

    return workerEvents.withAgentTap((event: AgentEvent) => {
      progressDigest.record(event)

      if (event.type === 'text-delta' && event.text) {
        retryState.hasVisibleOutput = true
        return
      }

      if (event.type === 'reasoning-delta' && event.text) {
        retryState.hasVisibleOutput = true
        return
      }

      if (event.type === 'tool-progress' && event.chunk) {
        retryState.hasVisibleOutput = true
      }

      if (
        event.type === 'tool-start' ||
        event.type === 'tool-progress' ||
        event.type === 'tool-done'
      ) {
        retryState.hasToolUse = true
      }
    })
  }

  /**
   * 统一发送 worker 线程状态事件。
   *
   * 状态事件必须走父总线（request.events）：worker 子总线只透传
   * 文本增量/重连/工具完成，worker 线程状态会被其智能体 handler 丢弃
   * （详见 ExecutionEventBus.forWorkerExecution）。
   */
  private emitWorkerStatus(args: WorkerStatusArgs): void {
    args.request.events.emitWorkerThread({
      kind: 'worker-thread',
      event: 'status',
      threadId: args.threadId,
      activationId: args.activationId,
      taskId: args.executionKey,
      title: args.title,
      agentName: args.agentName,
      roleId: args.typeConfig.roleId,
      phase: args.typeConfig.workerPhase,
      status: args.status,
      timestamp: Date.now(),
      input: args.request.input.prompt,
      summary: args.summary,
      error: args.error,
      subagentType: this.resolveTypeKey(args.typeConfig),
      customAgentName: toNullable(args.typeConfig.customAgentName),
      mode: args.dispatchMode,
      model: toNullable(args.resolvedModel ?? args.request.input.model),
      result: args.result,
    })
  }

  private emitDangerousConfirmationWorkerCard(
    args: Omit<WorkerStatusArgs, 'status' | 'summary' | 'error' | 'result'> & {
      summary: string
    }
  ): void {
    const timestamp = Date.now()
    args.request.events.emitWorkerThread({
      kind: 'worker-thread',
      event: 'chat-event',
      threadId: args.threadId,
      activationId: args.activationId,
      taskId: args.executionKey,
      title: args.title,
      agentName: args.agentName,
      roleId: args.typeConfig.roleId,
      phase: args.typeConfig.workerPhase,
      status: 'awaiting_confirmation',
      timestamp,
      input: args.request.input.prompt,
      summary: args.summary,
      subagentType: this.resolveTypeKey(args.typeConfig),
      customAgentName: toNullable(args.typeConfig.customAgentName),
      mode: args.dispatchMode,
      model: toNullable(args.resolvedModel ?? args.request.input.model),
      chatEvent: {
        type: 'notice',
        kind: 'user-action-card',
        payload: this.buildDangerousConfirmationWorkerCard(
          args.activationId,
          args.summary,
          timestamp
        ),
      },
    })
  }

  private buildDangerousConfirmationWorkerCard(
    activationId: string,
    summary: string,
    timestamp: number
  ): UserActionCard {
    return {
      id: `${activationId}:dangerous-confirmation:${timestamp}`,
      title: '等待父线程确认危险指令',
      description: `${summary}\n请在父线程授权卡片中处理；这里仅同步子 Agent 当前阻塞原因。`,
      tone: 'warning',
      icon: 'danger',
      blocking: false,
      actions: [
        {
          kind: 'acknowledge',
          label: '知道了',
          completedLabel: '已知晓',
          icon: 'confirm',
          disableAfterClick: true,
        },
      ],
      createdAt: timestamp,
    }
  }

  private formatWorkerFailureMessage(error: AppError): string {
    if (!this.connectionRetryHelper.isTransientConnectionError(error)) return error.message

    return [
      `模型/provider 连接中断（${error.code}）：${error.message}`,
      '安全自动恢复未能完成；这不是子 Agent 时间预算到期，也不是本地取消。',
    ].join('\n')
  }

  private formatTransientRetryStatus(error: AppError, attempt: number): string {
    return [
      `网络连接失败，正在重试子 Agent（${attempt + 1}/${SubAgentTransientRetryMaxAttempts}）`,
      truncate(error.message, 120),
    ].join('：')
  }

  /** 顶层执行结束后释放计数与信号量，避免无界增长。 */
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
    const chatConfig = {
      ...this.configService.chatConfig,
      modelSelection:
        request.config.modelSelection ?? this.configService.chatConfig.modelSelection,
    }
    const resourceId = toNullable(request.parentCtx.resourceId)
    const instruction = buildSubAgentDispatchInstruction(
      request.input,
      typeConfig,
      title,
      prompt.toolCategories,
      prompt.priorFindingsBriefing,
      type.readonlyMode
    )
    const route = this.applyEffortOverride(
      this.applyModelOverride(
        this.modelRouter.resolve(
          typeConfig.workerType,
          this.resolveRouteCategory(request, typeConfig),
          chatConfig,
          systemConfig
        ),
        control.resolvedModelOverride ?? request.input.model
      ),
      control.resolvedEffortOverride ?? request.input.effort
    )
    const resolvedModel = route.runtimeOverride.model
    this.sessionStore.updateSession(threadId, {
      request: {
        model: resolvedModel,
        route_category: this.resolveRouteCategory(request, typeConfig),
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
          abortSignal: this.combineAbortSignals(parentCtx.abortSignal, workerAbortSignal),
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
          turnCapDisabled: false,
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
      if (this.isAbortError(appError, effectiveParentCtx)) {
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
        if (this.isAbortError(retryAppError, effectiveParentCtx)) {
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

    for (let attempt = 1; attempt <= SubAgentTransientRetryMaxAttempts; attempt += 1) {
      try {
        return await runWithRoute(route)
      } catch (error) {
        const appError = AppError.from(error)
        if (this.isAbortError(appError, effectiveParentCtx)) throw appError

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
    if (attempt >= SubAgentTransientRetryMaxAttempts) return false
    return this.connectionRetryHelper.shouldRetryConnectionError(error, attempt, {
      abortSignal: effectiveParentCtx.abortSignal,
      hasToolUse: () => plan.control.retryState.hasToolUse,
      hasVisibleOutput: () => plan.control.retryState.hasVisibleOutput,
    })
  }

  private isAbortError(error: AppError, parentCtx: SubAgentToolContext): boolean {
    return parentCtx.abortSignal.aborted || error.code === 'EXECUTION_ABORTED'
  }

  private resolveInitialToolCategories(
    request: SubAgentDispatchRequest,
    typeConfig: ResolvedSubAgentTypeConfig
  ): ToolCategoryId[] {
    switch (request.input.toolScope ?? 'type_default') {
      case 'inherit':
        return dedupeToolCategories(request.parentCtx.codingSession.getEnabledToolCategories())
      case 'custom':
        return dedupeToolCategories(request.input.toolCategories ?? [])
      case 'type_default':
      default:
        return dedupeToolCategories([...typeConfig.toolCategories])
    }
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

    const enabledSetBefore = new Set(enabledBefore)
    const missingCategories = requestedCategories.filter(
      (categoryId) => !enabledSetBefore.has(categoryId)
    )

    if (!isEmpty(missingCategories)) {
      request.parentCtx.codingSession.enableToolCategories(missingCategories, reason)
    }

    const enabledAfter = request.parentCtx.codingSession.getEnabledToolCategories()
    const enabledSetAfter = new Set(enabledAfter)
    const skippedCategories = [
      ...blockedCategories,
      ...requestedCategories.filter((categoryId) => !enabledSetAfter.has(categoryId)),
    ]
    const approvedCategories = requestedCategories.filter((categoryId) =>
      enabledSetAfter.has(categoryId)
    )

    return {
      enabled: !isEmpty(approvedCategories),
      approved: !isEmpty(approvedCategories),
      autoApproved: true,
      reason,
      requestedCategories: expandedRequest,
      enabledCategories: enabledAfter,
      skippedCategories,
      message: isEmpty(skippedCategories)
        ? '主智能体已批准并开放这些工具分类；请在下一轮使用对应工具。'
        : !isEmpty(blockedCategories)
          ? `主智能体已处理请求，但子智能体永不开放这些工具分类：${blockedCategories.join(', ')}。其他未开放分类：${skippedCategories.filter((categoryId) => !blockedCategories.includes(categoryId)).join(', ') || '无'}。`
          : `主智能体只开放了部分工具分类，未开放：${skippedCategories.join(', ')}。`,
    }
  }

  private isBlockedToolCategory(categoryId: ToolCategoryId): boolean {
    return resolveCapabilityDelegationPolicy(this.capabilityPorts).blockedCategoryIds.includes(
      categoryId
    )
  }

  /**
   * 构造子智能体运行用的工具上下文：默认放行运行期确认请求，只把危险命令冒泡到父线程。
   */
  private buildAutonomousParentCtx(
    parentCtx: SubAgentToolContext,
    onDangerousConfirmation?: DangerousConfirmationStatusSink
  ): SubAgentToolContext {
    const execution = parentCtx.execution
    if (!execution) return parentCtx
    return {
      ...parentCtx,
      execution: this.buildAutonomousExecution(execution, onDangerousConfirmation),
    }
  }

  private buildAutonomousExecution(
    execution: NonNullable<SubAgentToolContext['execution']>,
    onDangerousConfirmation?: DangerousConfirmationStatusSink
  ): NonNullable<SubAgentToolContext['execution']> {
    // 子 Agent 无人值守放行策略上移到 ApprovalPort 策略层（宪章 §4 Ring 1）：默认全放行 +
    // 超高风险升级父线程。升级 riskScope 集合、终止/非终止审批语义、破坏性命令硬门化语义都住在
    // createUnattendedSubAgentApprovalPort（core tool-contract/approval.ts）单源，与危险命令门同居；
    // 派发器只负责把升级挂起/返回投影成 worker 线程状态卡（保留原确认卡 UI，只换触发源）。
    const approvalPort = createUnattendedSubAgentApprovalPort(execution, {
      onEscalationPending: (message) =>
        onDangerousConfirmation?.(
          'awaiting_confirmation',
          formatSubAgentHighRiskConfirmationStatus(message)
        ),
      onEscalationResolved: () =>
        onDangerousConfirmation?.('running', '高风险操作确认已返回，子 Agent 继续处理。'),
    })
    return {
      ...execution,
      awaitConfirmation: approvalPort.awaitConfirmation,
      awaitConfirmationDecision: approvalPort.awaitConfirmationDecision,
    }
  }

}

export { resolveSubAgentExecutionKey, SubAgentDispatcher }
export type { SubAgentDispatchRequest }
