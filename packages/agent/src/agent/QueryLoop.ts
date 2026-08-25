import { randomUUID } from 'node:crypto'

import type { ModelMessage } from 'ai'

import { resolveContextWindowBudget } from '@velaros-ai/agent'
import type {
  AgentModelInputModality,
  RunProfileSelectionId,
  SubAgentStructuredOutputContract,
  SubAgentUsage,
  ThinkingDepth,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import {
  isBlank,
  isEmpty,
  isNull,
  isPresent,
  toNullable,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { resolveCapabilityDelegationPolicy } from '../capabilities'
import { type AutoVerificationToolContext, tickLoopReminders } from '../coding'
import type { ExecutionSpanScopeFactory } from '../kernel'
import type { AgentModSeamDispatcher } from '../mods/AgentModSeams'
import {
  buildStructuredOutputRepairPrompt,
  compileSubAgentOutputSchema,
  parseSubAgentStructuredOutput,
} from '../sub-agent/StructuredOutput'

import {
  beginLoopTurnSpans,
  endLoopTurnSpansError,
  endLoopTurnSpansOk,
  executeLoopTurnWithContextOverflowRecovery,
  restartLoopTurnModelSpanAfterRetry,
  runAgentLoop,
} from './AgentLoop'
import { type ContextGovernanceSessionRegistry, resolveGovernanceSessionKey } from './context'
import { resolveContextDegradeAction } from './ContextDegradeLadder'
import {
  type AgentExecutionLimitOverrides,
  type AgentExecutionLimits,
  resolveAgentExecutionLimits,
} from './ExecutionLimits'
import {
  type AgentHistoryToolContext,
  createInternalFollowUpMessage,
} from './history'
import {
  AgentLoopContextUsageManager,
  type AgentLoopToolRegistry,
} from './LoopContextUsage'
import {
  buildSubAgentInstruction,
  createSubAgentContext,
  resolveSubAgentDelegation,
  resolveSubAgentToolScope,
  type SubAgentContextBase,
  type SubAgentOptionsLike,
} from './LoopRuntime'
import {
  type AgentLoopSurface,
  loopContinue,
  loopFinish,
  type LoopTurnVerdict,
  LoopWindDownGuard,
} from './LoopSurface'
import type {
  AgentModelProvider,
  AgentModelRequestOptions,
} from './model'
import type {
  ExecuteQueryTurnArgs,
  QueryTurnEvents,
  QueryTurnProvider,
  QueryTurnResult,
  QueryTurnToolContext,
  QueryTurnToolRegistry,
} from './QueryTurn'
import type { AgentRoleResolution, ResolveAgentRoleOptions } from './RoleTypes'
import { applyRunProfileToolExposure, resolveRunProfilePolicyForRuntime } from './RunProfile'
import type {
  AgentChatRuntimeConfig,
  AgentSystemRuntimeConfig,
} from './RuntimeConfiguration'
import { isReasoningOnlyEmptyResponseError } from './stream'
import {
  type AgentTurnCapabilitySnapshotSource,
  captureAgentTurnCapabilityContext,
  captureAgentTurnCapabilitySnapshot,
} from './TurnCapabilitySnapshot'

const MaxQueryLoopReasoningOnlyVisibleAnswerRecoveryAttempts = 2
const MaxSubAgentStructuredOutputRepairAttempts = 2
/**
 * 子 Agent 模型窗口未知时的保守回退（注入 `runtimeOverride` 的派发路径不带窗口）。
 * 编辑预算与运行档判档共用它——两处各写一个数就是两本账。
 */
const SubAgentFallbackContextWindow = 128_000

interface QueryLoopSubAgentRuntimeOverride {
  provider: AgentModelProvider
  providerId: string
  model: string
  supportedInputModalities?: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  thinkingDepth?: LooseOptional<ThinkingDepth>
}

interface QueryLoopSubAgentOptions<TEvents extends QueryTurnEvents> extends SubAgentOptionsLike {
  runtimeOverride?: QueryLoopSubAgentRuntimeOverride
  events?: TEvents
  /**
   * 软上限时间戳（epoch ms）。到点后注入一次收尾提醒让子 Agent 汇报进展并结束，
   * 而非硬杀；未设置则不施加软上限。
   */
  softDeadlineAt?: number
  /** 主 Agent relay 的运行中引导；每条消息只在子 Agent 某一轮 turn 开始时消费一次。 */
  consumeRelayedGuidance?: () => Nullable<string> | Promise<Nullable<string>>
  /** 续跑：注入已有对话历史，跳过从零构造的首条 user 消息。 */
  initialHistory?: ModelMessage[]
  /** 每轮结束后回写 history，供 session store 持久化。 */
  onHistoryUpdate?: (history: ModelMessage[]) => void
  /** 单 worker 中断信号（与父 abort 合并生效）。 */
  workerAbortSignal?: AbortSignal
  structuredOutputContract?: SubAgentStructuredOutputContract
  onStructuredOutput?: (value: unknown) => void
  /** 子 Agent 运行结束时回报本次 token/成本用量汇总（D9 usage 回传）。 */
  onUsage?: (usage: SubAgentUsage) => void
}

type QueryLoopToolContext = QueryTurnToolContext &
  AgentHistoryToolContext &
  AutoVerificationToolContext &
  SubAgentContextBase & {
    selectedSkillIds?: string[]
    codingSession: {
      setUsableContextWindowTokens?: (tokens: Nullable<number>) => void
      /**
       * 父会话选定的运行档（`'auto'` = 按模型窗口自动判档）。子 Agent 继承它做工具面预算——
       * 档位承诺的是「本次运行允许长期携带多少」，不是「只约束主会话」。
       */
      getRunProfile?: () => RunProfileSelectionId
    }
  }

interface QueryLoopRoleEngine {
  resolve(options: ResolveAgentRoleOptions): AgentRoleResolution
}

interface QueryLoopRunContext<TContext extends QueryLoopToolContext, TSignals> {
  buildSystemPrompt(args: {
    chatConfig: AgentChatRuntimeConfig
    systemConfig: AgentSystemRuntimeConfig
    messages: ModelMessage[]
    roleResolution: AgentRoleResolution
    toolContext: TContext
    identity?: string
    capabilityContext: Nullable<TSignals>
    thinkingDepth?: LooseOptional<AgentSystemRuntimeConfig['thinkingDepth']>
    goalMode?: boolean
  }): Promise<{ systemPrompt: string }>
}

interface QueryLoopRoleRuntime {
  provider: QueryTurnProvider
  providerId: string
  model: string
  providerModel?: string
  contextWindow?: number
  supportedInputModalities: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  resolutionSource: string
  resolutionTrace: readonly unknown[]
  fallbackReason?: LooseOptional<string>
}

interface QueryLoopRuntime {
  createAgentProvider(input: unknown): QueryTurnProvider
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown
  ): Promise<QueryLoopRoleRuntime>
}

interface QueryLoopTurnRunner<
  TContext extends QueryLoopToolContext,
  TEvents extends QueryTurnEvents,
> {
  executeQueryTurn(
    args: Omit<ExecuteQueryTurnArgs<TContext>, 'toolContext' | 'events'> & {
      toolContext: TContext
      events?: TEvents & QueryTurnEvents
    }
  ): Promise<QueryTurnResult>
  getAllowedSubAgentTools(tools?: string[]): string[]
}

type QueryLoopToolRegistry<
  TContext extends QueryLoopToolContext,
> = AgentLoopToolRegistry<TContext> &
  QueryTurnToolRegistry<TContext> & {
  names: string[]
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools?: string[]
  ) => Record<string, number>
  getDescriptor(toolName: string): LooseOptional<{ categoryId?: LooseOptional<ToolCategoryId> }>
} & Partial<AgentTurnCapabilitySnapshotSource<QueryLoopToolRegistry<TContext>>>

type QueryLoopToolCategoryResolver = (categories: ToolCategoryId[]) => string[]

interface ExecuteQueryLoopArgs<
  TContext extends QueryLoopToolContext = QueryLoopToolContext,
  TEvents extends QueryTurnEvents = QueryTurnEvents,
  TSignals = unknown,
> {
  /** 父 Agent 委派给子 Agent 的任务文本。 */
  task: string
  /** 子 Agent 运行选项，可限制工具类别、角色和最大步数。 */
  opts: QueryLoopSubAgentOptions<TEvents>
  /** 父工具上下文，子 Agent 会继承大部分能力并收窄工具。 */
  parentCtx: TContext
  /** 聊天模型配置快照。 */
  chatConfig: AgentChatRuntimeConfig
  /** 系统配置快照。 */
  systemConfig: AgentSystemRuntimeConfig
  /** Collect capability-owned context. Agent Runtime treats the snapshot as opaque. */
  collectCapabilityContext: (messages: ModelMessage[]) => Promise<Nullable<TSignals>>
}

/**
 * 子 Agent 面（B5 单引擎双面：装配 AgentLoop 引擎的无 UI 面）。
 *
 * 与主 agent 面（SoloStreamLoop）的装配差异：
 * - 不直接向 renderer 推流，最终文本作为父工具调用结果返回。
 * - 工具列表会按委派合约和目标角色收窄。
 * - 子 Agent 不能继续创建孙 Agent，避免无限委派。
 * - 中止收敛 = 抛 EXECUTION_ABORTED 冒泡给派发器（主面 = 状态化 + UI 事件）。
 * - 轮次上限多一根时间轴（softDeadlineAt），机制与主面同一份 LoopWindDownGuard。
 */
class QueryLoop<
  TContext extends QueryLoopToolContext = QueryLoopToolContext,
  TEvents extends QueryTurnEvents = QueryTurnEvents,
  TSignals = unknown,
> {
  private readonly log = logRuntime.tag('QueryLoop')
  private readonly contextUsage: AgentLoopContextUsageManager<TContext>
  private readonly executionLimits: AgentExecutionLimits

  constructor(
    /** 模型 runtime 和连接错误处理。 */
    private readonly runtimeHelper: QueryLoopRuntime,
    /** 执行单轮非流式模型调用。 */
    private readonly turnHelper: QueryLoopTurnRunner<TContext, TEvents>,
    /**
     * 治理会话登记处（宿主级单实例，与主面同一份）。
     * 本 loop 只在缺页降级时用它强开一次 epoch；常规治理在编译期由 `ProviderRequestCompiler` 完成。
     */
    private readonly governanceSessions: ContextGovernanceSessionRegistry,
    /** 构建子 Agent system prompt。 */
    private readonly runContextHelper: QueryLoopRunContext<TContext, TSignals>,
    /** 解析目标角色能力。 */
    private readonly roleEngine: QueryLoopRoleEngine,
    /** 查询工具描述、类别和 provider 可见性。 */
    private readonly toolRegistry: QueryLoopToolRegistry<TContext>,
    /** 宿主工具集合的类别索引。 */
    private readonly getToolNamesForCategories: QueryLoopToolCategoryResolver,
    /**
     * 可选执行观测区段端口（#37 阶段 C 片 2；D6 端口纪律）。缺省为空操作，未装配宿主账本时
     * 不产生观测与开销。装配后，每次子智能体委派都会创建独立的顶层运行区段：使用新的
     * `runId`，令 `parentSpanId` 为空，并写入父会话的同一账本；它通过 `sessionId` 与父级关联，
     * 不嵌入父级派发工具区段。该区段下辖子智能体各轮的回合与模型区段，并把回合作用域作为
     * 工具区段开启器注入本轮 `QueryTurn` 的 `ToolExecutor`。
     */
    private readonly spanScopeFactory: LooseOptional<ExecutionSpanScopeFactory> = null,
    executionLimitOverrides: AgentExecutionLimitOverrides = {},
    /**
     * 可选 mod 拦截 seam 派发器（裁决 9 机制②）；与主面共用同一实例，逐轮透传给 QueryTurn 的
     * ToolExecutor。缺省 null → 全链 no-op，行为逐字节不变。
     */
    private readonly seams: LooseOptional<AgentModSeamDispatcher> = null
  ) {
    this.executionLimits = resolveAgentExecutionLimits(executionLimitOverrides)
    this.contextUsage = new AgentLoopContextUsageManager(toolRegistry)
  }

  /**
   * 收尾提醒：到运行软上限（时间或步数，先到先触发）后注入，要求模型立刻停止调用工具、
   * 用一段话汇报进展，并在开头注明因运行上限提前收尾，便于父 Agent 判断是否续派。
   */
  private buildWindDownReminder(startedAt: number): string {
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
    return [
      `[系统] 你已运行约 ${minutes} 分钟或较多步骤，达到本次子任务的运行软上限。`,
      '请立即停止调用任何工具，用一段话向上级汇报：',
      '1) 已完成了什么；2) 当前卡在哪一步/还差什么；3) 建议的下一步。',
      '在汇报开头注明「因运行上限提前收尾」，然后结束本次回复。',
    ].join('\n')
  }

  /** 执行一次子 Agent 委派任务。 */
  public async execute(args: ExecuteQueryLoopArgs<TContext, TEvents, TSignals>): Promise<string> {
    const startedAt = Date.now()
    const compiledStructuredOutput = args.opts.structuredOutputContract
      ? compileSubAgentOutputSchema(args.opts.structuredOutputContract.schema)
      : null
    const delegation = resolveSubAgentDelegation({
      task: args.task,
      opts: args.opts,
      parentRoleId: args.parentCtx.role.id,
    })
    const delegatedInstruction = buildSubAgentInstruction(delegation)
    const initialHistory = args.opts.initialHistory ?? []
    const hasInitialHistory = !isEmpty(initialHistory)
    const history: ModelMessage[] = hasInitialHistory
      ? [...initialHistory]
      : [{ role: 'user', content: delegatedInstruction }]
    if (hasInitialHistory) {
      history.push(createInternalFollowUpMessage(delegatedInstruction))
    }
    // 子 Agent 锁定目标角色，角色决定默认工具、prompt 和下一步委派方向。
    const roleResolution = this.roleEngine.resolve({
      lockedRoleId: delegation.targetRoleId,
      knownToolNames: this.toolRegistry.names,
      selectedSkillIds: args.parentCtx.selectedSkillIds ?? [],
    })
    this.log.info('sub-agent prepare start', {
      roleId: delegation.targetRoleId,
    })
    // runtimeOverride 用于 team worker 指定模型；否则沿用聊天配置解析 runtime。
    const roleRuntime = args.opts.runtimeOverride
      ? {
          provider: args.opts.runtimeOverride.provider,
          providerId: args.opts.runtimeOverride.providerId,
          model: args.opts.runtimeOverride.model,
          providerModel: args.opts.runtimeOverride.model,
          contextWindow: undefined,
          supportedInputModalities:
            args.opts.runtimeOverride.supportedInputModalities ?? ['text'],
          modelRequestOptions: args.opts.runtimeOverride.modelRequestOptions,
          resolutionSource: 'injected',
          resolutionTrace: [],
        }
      : await this.runtimeHelper.resolveRoleRuntime(
          args.chatConfig.modelSelection,
          args.systemConfig.modelRuntimeContext
        )
    const delegationPolicy = resolveCapabilityDelegationPolicy(args.parentCtx.capabilityPorts)
    const { allowedTools, allowedCategories } = resolveSubAgentToolScope({
      delegation,
      authorizedToolNames: args.opts.allowedTools,
      roleResolution,
      getToolNamesForCategories: this.getToolNamesForCategories,
      getAllowedSubAgentTools: (tools) => this.turnHelper.getAllowedSubAgentTools(tools),
      getToolCategoryId: (toolName) =>
        toNullable(this.toolRegistry.getDescriptor(toolName)?.categoryId),
      blockedToolNames: delegationPolicy.blockedToolNames,
      blockedCategoryIds: delegationPolicy.blockedCategoryIds,
    })
    const contextEpochScope =
      args.opts.contextEpochScope?.trim() ||
      [
        'sub-agent',
        resolveGovernanceSessionKey(args.parentCtx.sessionId),
        delegation.identity?.trim() || roleResolution.id,
        Date.now().toString(36),
        Math.random().toString(36).slice(2),
      ].join(':')
    // 治理账本键 = 本次派发的上下文作用域。子 agent 与父会话共用 sessionId（那是 PayloadStore 的
    // 分区，动不得），但它跑的是另一条消息序列，共用一本账本会让父子交替编译每轮都整本重建
    // （审计 U12）。作用域每次派发唯一、跨本子 agent 全部轮次稳定，正是账本要的粒度；缺页阶梯
    // 强开 epoch 也必须查这同一个键，否则查到的是父会话的账本。
    const governanceSessionId = contextEpochScope
    // 只有需要代码上下文的角色才收集信号，减少无关查询开销。
    // TODO(performance): 若 profile 显示子 Agent 生命周期足够长，再引入 incremental refresh。
    const capabilityContext = roleResolution.usesCapabilityContext
      ? await args.collectCapabilityContext(history)
      : null
    const childCtx = createSubAgentContext<TContext>({
      parentCtx: args.parentCtx,
      log: logRuntime.tag('SubAgent'),
      roleResolution,
      allowedTools,
      allowedCategories,
      getAllowedSubAgentTools: (tools) => this.turnHelper.getAllowedSubAgentTools(tools),
      getToolNamesForCategories: this.getToolNamesForCategories,
      requestToolCategories: args.opts.requestToolCategories,
      blockedToolNames: delegationPolicy.blockedToolNames,
      blockedCategoryIds: delegationPolicy.blockedCategoryIds,
    })
    childCtx.setSupportedModelInputModalities(roleRuntime.supportedInputModalities)
    // 子 Agent 同样下发输入侧可用窗口，让其编辑工具按自身模型窗口做编辑预算（缺省回退保守默认）。
    childCtx.codingSession.setUsableContextWindowTokens?.(
      resolveContextWindowBudget({
        contextWindow: roleRuntime.contextWindow ?? SubAgentFallbackContextWindow,
      }).usableContextWindow
    )

    // 运行档预算下沉到子面（审计 A9）：档位对用户的承诺是「本次运行允许长期携带多少」，不是
    // 「只约束主会话」。此前主面走 `applyRunProfileToolExposure`、子面完全不走——一旦模型派出
    // 三五个并行子 Agent，每个都端着完整工具面跑，预算最该生效的场景恰好是唯一不生效的场景。
    //
    // 判档规则：继承父会话**选定**的档位；选的是 `'auto'` 时按子 Agent 自己的模型窗口判，窗口未知
    // （注入 runtimeOverride 的派发路径）时用与编辑预算同一个保守回退。显式选档永远赢——
    // `resolveRunProfilePolicyForRuntime` 见到非 auto 的选择就直接采纳，不看窗口。
    const subAgentRunProfile = resolveRunProfilePolicyForRuntime({
      requested: args.parentCtx.codingSession.getRunProfile?.(),
      contextWindow: roleRuntime.contextWindow ?? SubAgentFallbackContextWindow,
      model: roleRuntime.model,
    }).profile

    this.log.info('sub-agent start', {
      roleId: delegation.targetRoleId,
      allowedTools: allowedTools.length,
      runProfile: subAgentRunProfile,
    })

    // maxSteps 已移除：子 Agent 跑到模型自主收手（无工具调用）或被中断为止。
    // 循环护栏有三道：
    // 1) 收尾提醒：若提醒被反复触发，最多注入若干轮后强制收尾，避免无限轮询。
    // 2) 运行软上限（时间或步数，先到先触发；护栏 1 机制单源在 LoopWindDownGuard）：
    //    - 时间：到 softDeadlineAt（父 Agent 计算的软上限时间戳）；
    //    - 步数：到隐藏步数熔断软上限（对齐 Cursor/Codex/Claude Code，兜「快转」）。
    //    触发后注入一条收尾提醒让模型带进展返回（不硬杀），若模型无视提醒继续调工具，
    //    最多再放行 AgentTurnCapWindDownMargin 轮即强制收尾，把当前进展返回父 Agent——
    //    中断权在父线程。
    const MaxFinishingReminderRounds = 2
    let finishingReminderRounds = 0
    let reasoningOnlyVisibleAnswerRecoveries = 0
    let structuredOutputRepairAttempts = 0
    // 这里曾有一格 `turnCapDisabled`（关闭轮数上限，2026-08-06 删）：全链唯一生产者硬编码
    // `false`，从没有任何路径把它置真；更坏的是同一个布尔还被当作子 Agent 的目标模式开关
    // （见下方 buildSystemPrompt 的 goalMode）——想给长跑型子 Agent 解除轮数熔断的人会顺手
    // 改掉它的提示词人格，反之亦然。两件毫无关系的事不共用一个旋钮：轮数熔断的唯一权威是
    // `executionLimits.subAgentMaxTurns`（null = 不设硬上限）。
    const subAgentMaxTurns = this.executionLimits.subAgentMaxTurns
    const windDownGuard = new LoopWindDownGuard({
      hardCapTurns: subAgentMaxTurns ?? Number.POSITIVE_INFINITY,
      disabled: isNull(subAgentMaxTurns),
      deadlineAt: toNullable(args.opts.softDeadlineAt),
    })

    // D9 usage 回传：跨全部轮次累加供应方回报的 token/成本（每轮 model span 四字段的同源冒泡），
    // 收尾时经 onUsage 回调冒泡到派发结果 envelope。缺字段的轮次不计入（保持 null 直到有回报）。
    let usageInputTokens: Nullable<number> = null
    let usageOutputTokens: Nullable<number> = null
    let usageCostUsd: Nullable<number> = null
    const reportUsage = (): void => {
      if (isNull(usageInputTokens) && isNull(usageOutputTokens) && isNull(usageCostUsd)) return
      const totalTokens =
        isNull(usageInputTokens) && isNull(usageOutputTokens)
          ? null
          : (usageInputTokens ?? 0) + (usageOutputTokens ?? 0)
      args.opts.onUsage?.({
        inputTokens: toOptional(usageInputTokens),
        outputTokens: toOptional(usageOutputTokens),
        totalTokens: toOptional(totalTokens),
        costUsd: toOptional(usageCostUsd),
      })
    }

    // 观测（#37 阶段 C 片 2）：本次子 Agent 委派 = 一个独立顶层 run span，落父会话同一 span 账本、靠
    // sessionId 关联；带子 Agent 身份（identity/角色）与派发来源（父角色）标注，令同会话多 run 树可辨识。
    // 缺省端口时为 null（全链 no-op）。各终止分支就近收敛（scope.end 失败隔离、幂等首闭为准）。
    const runScope = toNullable(
      this.spanScopeFactory?.beginRun({
        runId: randomUUID(),
        sessionId: resolveGovernanceSessionKey(args.parentCtx.sessionId),
        // Child runs currently inherit the parent session but not the renderer message envelope.
        rootInputId: null,
        agentName: delegation.identity?.trim() || roleResolution.id,
        dispatchSource: args.parentCtx.role.id,
      })
    )

    const isAborted = (): boolean =>
      args.parentCtx.abortSignal.aborted || !!args.opts.workerAbortSignal?.aborted

    const runTurn = async (turn: number): Promise<LoopTurnVerdict<string>> => {
      const turnToolRegistry = captureAgentTurnCapabilitySnapshot(this.toolRegistry)
      const turnToolContext = captureAgentTurnCapabilityContext(childCtx)
      const supportedInputModalities = new Set(roleRuntime.supportedInputModalities)
      const candidateToolsForTurn = turnToolContext.getCurrentVisibleToolNames().filter(
        (toolName) =>
          (turnToolRegistry.getDescriptor(toolName)?.requiredModelInputModalities ?? []).every(
            (modality) => supportedInputModalities.has(modality)
          )
      )
      const candidateToolSchemaChars = this.prepareToolSchemaChars(
        turnToolRegistry,
        turnToolContext,
        candidateToolsForTurn
      )
      // 与主面（CapabilityRunPlanner）同一套预算装配件：按档位的 maxToolCount / maxToolSchemaChars
      // 收窄本轮工具面。子面没有主面的换页阶梯，因此这里只做一次静态裁剪——alwaysResident 的工具
      // 先占预算不被淘汰，其余按 tier/rank/schema 字节排队。
      const { allowedTools: allowedToolsForTurn, droppedTools } = applyRunProfileToolExposure(
        candidateToolsForTurn,
        subAgentRunProfile,
        {
          toolDescriptors: turnToolContext.listTools('enabled'),
          toolSchemaChars: candidateToolSchemaChars,
        }
      )
      if (!isEmpty(droppedTools)) {
        this.log.info('sub-agent tool exposure trimmed by run profile', {
          turn,
          runProfile: subAgentRunProfile,
          exposed: allowedToolsForTurn.length,
          dropped: droppedTools.length,
        })
      }
      const toolSchemaChars = candidateToolSchemaChars
        ? Object.fromEntries(
            allowedToolsForTurn.map((toolName) => [
              toolName,
              candidateToolSchemaChars[toolName] ?? 0,
            ])
          )
        : undefined

      const { systemPrompt } = await this.runContextHelper.buildSystemPrompt({
        chatConfig: args.chatConfig,
        systemConfig: args.systemConfig,
        messages: history,
        roleResolution,
        toolContext: turnToolContext,
        identity: delegation.identity,
        capabilityContext,
        thinkingDepth: args.opts.runtimeOverride?.thinkingDepth ?? args.systemConfig.thinkingDepth,
        // 子 Agent 不进目标模式：目标是**父会话**的状态（goal:* 工具族与 SoloFinishingGate 都住主面），
        // 一次委派是有界的子任务，它自己没有「持续推进到目标达成」这层语义。写死 false 而不是留一个
        // 半接线的入参——这一格曾经绑在 `turnCapDisabled` 上（恒 false），等于「声明有、永远关」。
        goalMode: false,
      })
      const contextUsageOptions = this.contextUsage.buildContextUsageOptions(
        roleRuntime.model,
        turnToolContext,
        allowedToolsForTurn,
        roleRuntime.contextWindow,
        toolSchemaChars,
        turnToolRegistry
      )
      // 送核前的用量估算：只喂 MMU 校准闭环（下面 recordActualUsage）。子 Agent 的历史同样**不在
      // loop 层改写**——清洗与降级各归其位（结构自愈在编译前，降级在驻留账本的 epoch）。
      const predictedInputTokens = this.contextUsage.estimateUsage(
        roleRuntime.model,
        systemPrompt,
        history,
        contextUsageOptions
      ).estimatedTokens

      // 观测（护栏 4，机制单源在 AgentLoop）：本轮 = 子 Agent 的 turn span（run 的子）；provider 请求 =
      // model span（turn 的子，usage 收敛在此）。turn scope 兼作 tool span 开启器注入本轮 QueryTurn 的
      // ToolExecutor（缺省 no-op）。
      const spans = beginLoopTurnSpans(runScope, {
        turn,
        roleId: roleResolution.id,
        model: roleRuntime.model,
        providerModel: roleRuntime.providerModel,
        provider: roleRuntime.providerId,
      })

      // query turn 是非流式调用；有工具调用时结果会直接追加到 history。
      // 缺页兜底（护栏 2，机制单源在 AgentLoop）：上下文超限时沿降级阶梯逐级释放压力后
      // 用同一轮重试，耗尽则优雅抛出。
      let result: QueryTurnResult
      for (;;) {
        try {
          result = await executeLoopTurnWithContextOverflowRecovery({
            turn,
            abortSignal: args.parentCtx.abortSignal,
            executeTurn: () =>
              this.turnHelper.executeQueryTurn({
                provider: roleRuntime.provider,
                model: roleRuntime.model,
                turn,
                modelRequestOptions: roleRuntime.modelRequestOptions,
                systemPrompt,
                history,
                contextWindow: roleRuntime.contextWindow,
                supportedInputModalities: roleRuntime.supportedInputModalities,
                contextUsageOptions,
                toolSchemaChars,
                toolContext: turnToolContext,
                toolRegistry: turnToolRegistry,
                allowedTools: allowedToolsForTurn,
                events: args.opts.events,
                streamTextDeltas: !!args.opts.streamTextDeltas,
                idleStallTimeoutMs: this.executionLimits.modelStreamIdleTimeoutMs,
                onModelRequestRetry: (error) =>
                  restartLoopTurnModelSpanAfterRetry(spans, error),
                contextEpochScope,
                governanceSessionId,
                // 观测：本轮 tool span 开启器（子 Agent 自己的 turn scope）；缺省 no-op。
                toolSpanOpener: toOptional(spans.turnScope),
                // mod 接缝：与主面同一派发器；缺省 null → 全链 no-op。
                seams: this.seams,
              }),
            resolveAction: (attempt) => resolveContextDegradeAction('query', attempt),
            // 缺页降级：query 链只有「强开一次 epoch」这一级（无运行档工具暴露可收窄），
            // 压不下去即 surrender —— 尾保护是投影级硬不变量，不设压尾旁路。
            applyAction: async (action) => {
              if (action.kind !== 'govern-epoch') return false

              const report = this.governanceSessions.requestEpoch(governanceSessionId, {
                modelWindowTokens: roleRuntime.contextWindow,
                source: 'overflow-recovery',
              })
              if (report?.applied) {
                this.log.warn('sub-agent recovered context overflow via governance epoch', {
                  turn,
                  level: action.level,
                  epoch: report.epoch,
                  savingPercent: report.savingPercent,
                  beforePercent: report.beforePercent,
                  afterPercent: report.afterPercent,
                })
              }
              return !!report?.applied
            },
            surrenderLogMessage: 'sub-agent exhausted context degrade ladder; surrendering',
            log: this.log,
          })
          break
        } catch (error) {
          const appError = AppError.from(error)
          if (
            this.shouldRecoverReasoningOnlyEmptyResponse(
              error,
              args,
              reasoningOnlyVisibleAnswerRecoveries
            )
          ) {
            reasoningOnlyVisibleAnswerRecoveries += 1
            history.push(
              createInternalFollowUpMessage(this.buildReasoningOnlyVisibleAnswerRecoveryPrompt())
            )
            args.opts.events?.emitRuntime(
              ChatRuntimeEvents.retryingTurn(
                turn,
                reasoningOnlyVisibleAnswerRecoveries,
                MaxQueryLoopReasoningOnlyVisibleAnswerRecoveryAttempts,
                appError.message
              )
            )
            this.log.warn(
              'sub-agent query turn returned reasoning-only output, requesting visible answer',
              {
                turn,
                model: roleRuntime.model,
                recoveryAttempt: reasoningOnlyVisibleAnswerRecoveries,
                code: appError.code,
              }
            )
            continue
          }
          // 护栏 4：本轮 provider 回合失败就近收敛 turn/model span；run span 随即收敛后冒泡。
          endLoopTurnSpansError(spans, appError)
          runScope?.end({
            status: args.parentCtx.abortSignal.aborted ? 'aborted' : 'error',
          })
          throw error
        }
      }
      // 观测：provider 回合收敛 —— usage 富化挂在本确定 turn 的 model span（与主 Agent 面同一份
      // 护栏 4 机制，四字段从 QueryTurnResult 的 stream diagnostics + 请求指纹回传）。子 Agent 不构造
      // promptSegments/capabilityContextAudit，审计传空数组。
      endLoopTurnSpansOk(spans, result, {
        systemPrompt,
        promptSegments: [],
        skippedPromptSegments: [],
      })

      // MMU 反馈：用供应方真实输入 token 校准本模型的估算系数。
      this.contextUsage.recordActualUsage(
        roleRuntime.model,
        predictedInputTokens,
        toNullable(result.inputTokens)
      )

      // D9 usage 累加：与 model span 同源（本确定 turn 的供应方回合）。
      if (isPresent(result.inputTokens)) {
        usageInputTokens = (usageInputTokens ?? 0) + result.inputTokens
      }
      if (isPresent(result.outputTokens)) {
        usageOutputTokens = (usageOutputTokens ?? 0) + result.outputTokens
      }
      if (isPresent(result.costUsd)) {
        usageCostUsd = (usageCostUsd ?? 0) + result.costUsd
      }

      if (!result.hasToolUse) {
        // 收尾轮：模型停止工具调用，此时才允许注入 postEditReminder。
        // 这与主 agent 面保持一致：不在每次 edit 后触发，只在模型真正停下来时才提醒。
        // 提醒轮次有上限，超过后即便仍有提醒也强制收尾，避免无限轮询。
        const finishingReminders =
          finishingReminderRounds < MaxFinishingReminderRounds
            ? await tickLoopReminders({
                mode: 'sub-agent',
                phase: 'finishing',
                toolContext: turnToolContext,
              })
            : []
        if (!isEmpty(finishingReminders)) {
          for (const reminder of finishingReminders) {
            history.push(createInternalFollowUpMessage(reminder))
          }
          finishingReminderRounds += 1
          return loopContinue()
        }
        // 早退路径前 re-check abort：tickLoopReminders 是异步的，期间父 Agent 可能取消；
        // 如果不在这里截断，子 Agent 会返回 result.text 让父 Agent 继续派活，而父 Agent
        // 已经处于 aborted 状态，整条链路状态会错位。
        if (isAborted()) {
          runScope?.end({ status: 'aborted' })
          throw new AppError('EXECUTION_ABORTED', '子 Agent 运行被终止。')
        }
        if (compiledStructuredOutput) {
          const structured = parseSubAgentStructuredOutput(result.text, compiledStructuredOutput)
          if (!structured.success) {
            if (structuredOutputRepairAttempts >= MaxSubAgentStructuredOutputRepairAttempts) {
              runScope?.end({ status: 'error' })
              throw new AppError(
                'VALIDATION',
                `子 Agent 结构化输出连续校验失败：${structured.issues.join('；')}`
              )
            }
            structuredOutputRepairAttempts += 1
            history.push(
              createInternalFollowUpMessage(
                buildStructuredOutputRepairPrompt(
                  compiledStructuredOutput.serialized,
                  structured.issues
                )
              )
            )
            args.opts.onHistoryUpdate?.(history)
            return loopContinue()
          }
          args.opts.onStructuredOutput?.(structured.data)
        }
        this.log.info('sub-agent end', {
          status: 'completed',
          turns: turn,
          durationMs: Date.now() - startedAt,
        })
        runScope?.end({ status: 'ok' })
        args.opts.onHistoryUpdate?.(history)
        reportUsage()
        return loopFinish(result.text)
      }

      // 软上限已触发但模型仍在调用工具（护栏 1 margin 记账，机制单源在 LoopWindDownGuard）：
      // 最多再放行 AgentTurnCapWindDownMargin 轮，超出即强制收尾，带着当前进展返回父 Agent
      // （不硬杀整条链路）。
      if (windDownGuard.recordToolUseTurn()) {
        this.log.info('sub-agent end', {
          status: 'wind-down-forced',
          turns: turn,
          durationMs: Date.now() - startedAt,
        })
        runScope?.end({ status: 'ok' })
        args.opts.onHistoryUpdate?.(history)
        reportUsage()
        return loopFinish(
          result.text.trim() ||
            '子 Agent 已达运行软上限，带当前进展返回（模型未生成总结）。请检查资源变更后决定是否续派或接手。'
        )
      }

      // 工具调用轮：仅检查紧急提醒（验证失败），不注入 postEditReminder。
      // postEditReminder 属于收尾阶段，在每次 edit 后注入会驱使模型过早进入验证循环。
      const afterToolReminders = await tickLoopReminders({
        mode: 'sub-agent',
        phase: 'after-tool',
        toolContext: turnToolContext,
      })
      for (const reminder of afterToolReminders) {
        history.push(createInternalFollowUpMessage(reminder))
      }
      args.opts.onHistoryUpdate?.(history)
      return loopContinue()
    }

    const surface: AgentLoopSurface<string> = {
      // 护栏 3（中止门）：子面收敛 = 收 run span 后抛 EXECUTION_ABORTED 冒泡给派发器。
      isAborted,
      onAborted: () => {
        runScope?.end({ status: 'aborted' })
        throw new AppError('EXECUTION_ABORTED', '子 Agent 运行被终止。')
      },
      beforeTurn: async (turn) => {
        await consumeQueryLoopRelayedGuidance({
          turn,
          history,
          consumeRelayedGuidance: args.opts.consumeRelayedGuidance,
          log: this.log,
        })
      },
      windDown: {
        guard: windDownGuard,
        onTriggered: (reason, turn) => {
          history.push(createInternalFollowUpMessage(this.buildWindDownReminder(startedAt)))
          this.log.info('sub-agent wind-down triggered', {
            reason,
            turns: turn,
            durationMs: Date.now() - startedAt,
          })
        },
      },
      runTurn,
    }
    try {
      return await runAgentLoop(surface)
    } finally {
      // 子 agent 的账本随派发结束即弃：这条消息序列不会再被编译，留着只占 registry 的名额
      // （每次派发一个键，长跑会话会把 128 个格子迅速填满，把真正长寿的父会话挤出去）。
      this.governanceSessions.invalidateSession(governanceSessionId)
    }
  }

  private prepareToolSchemaChars(
    toolRegistry: QueryLoopToolRegistry<TContext>,
    toolContext: TContext,
    allowedTools: string[]
  ): Readonly<Record<string, number>> | undefined {
    const measured = toolRegistry.estimateToolSerializedCharsByName?.(
      toolContext,
      allowedTools
    )
    if (!measured) return undefined

    if (!allowedTools.every((toolName) => Object.prototype.hasOwnProperty.call(measured, toolName)))
      return undefined

    return Object.fromEntries(
      allowedTools.map((toolName) => [toolName, Math.max(0, measured[toolName] ?? 0)])
    )
  }

  private shouldRecoverReasoningOnlyEmptyResponse(
    error: unknown,
    args: ExecuteQueryLoopArgs<TContext, TEvents, TSignals>,
    recoveryAttempts: number
  ): boolean {
    if (args.parentCtx.abortSignal.aborted || args.opts.workerAbortSignal?.aborted) return false
    if (recoveryAttempts >= MaxQueryLoopReasoningOnlyVisibleAnswerRecoveryAttempts) return false

    return isReasoningOnlyEmptyResponseError(error, 'query')
  }

  private buildReasoningOnlyVisibleAnswerRecoveryPrompt(): string {
    return [
      'The previous sub-agent response was reasoning-only and did not include any visible answer for the parent agent.',
      'Continue now with a visible answer in normal assistant text.',
      'Do not return reasoning-only output again.',
      'If a tool is still needed, emit a fresh complete tool call with full valid arguments; otherwise answer directly.',
    ].join('\n')
  }
}

async function consumeQueryLoopRelayedGuidance(input: {
  turn: number
  history: ModelMessage[]
  consumeRelayedGuidance?: () => Nullable<string> | Promise<Nullable<string>>
  log: Pick<ReturnType<typeof logRuntime.tag>, 'info'>
}): Promise<void> {
  const relay = (await input.consumeRelayedGuidance?.())?.trim()
  if (!relay || isBlank(relay)) return

  input.history.push(
    createInternalFollowUpMessage(
      [
        '[主控 relay 引导]',
        '上级主 Agent 已理解用户追加引导，并将以下要点转交给你继续执行。',
        '请按主控表述行动；不要假设你能看到用户原文。',
        '',
        relay,
      ].join('\n')
    )
  )
  input.log.info('sub-agent relayed guidance consumed', { turn: input.turn })
}

export { QueryLoop }
export { QueryLoop as AgentQueryLoop }
export type {
  ExecuteQueryLoopArgs,
  QueryLoopRoleEngine,
  QueryLoopRoleRuntime,
  QueryLoopRunContext,
  QueryLoopRuntime,
  QueryLoopSubAgentOptions,
  QueryLoopSubAgentRuntimeOverride,
  QueryLoopToolCategoryResolver,
  QueryLoopToolContext,
  QueryLoopToolRegistry,
  QueryLoopTurnRunner,
}
