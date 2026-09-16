import { randomUUID } from 'node:crypto'

import type { ModelMessage } from 'ai'

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

import type { AgentChatRuntimeConfig, AgentModelRequestOptions, AgentSystemRuntimeConfig,ExecutionSpanScopeFactory } from '../../contract/requires.js'
import type { AgentModelInputModality } from '../../types/agent.js'
import type { AgentExecutionLimitOverrides, AgentExecutionLimits, AgentLoopSurface, ExecuteQueryLoopArgs, ExecuteQueryTurnArgs, LoopTurnVerdict, QueryLoopApi as QueryLoopContract, QueryLoopRoleEngine, QueryLoopToolCategoryResolver, QueryLoopToolContext, QueryLoopToolRegistry, QueryTurnEvents, QueryTurnProvider } from '../../types/loop.js'
import type { AgentModSeamDispatcherApi } from '../../types/mods.js'
import type { ContextGovernanceSessionRegistryApi } from '../../types/residency.js'
import type { AgentRoleResolution } from '../../types/runner.js'
import { resolveCapabilityDelegationPolicy } from '../../utils/capabilities'
import { resolveContextWindowBudget } from '../../utils/context/context-budget'
import {
  buildStructuredOutputRepairPrompt,
  compileSubAgentOutputSchema,
  parseSubAgentStructuredOutput,
} from '../../utils/delegation/structured-output'
import { createInternalFollowUpMessage } from '../../utils/history/internal-messages'
import {
  beginLoopTurnSpans,
  endLoopTurnSpansError,
  endLoopTurnSpansOk,
  executeLoopTurnWithContextOverflowRecovery,
  restartLoopTurnModelSpanAfterRetry,
  runAgentLoop,
} from '../../utils/loop/agent-loop'
import { resolveContextDegradeAction } from '../../utils/loop/context-degrade-ladder'
import { resolveAgentExecutionLimits } from '../../utils/loop/execution-limits'
import { buildSubAgentInstruction, createSubAgentContext, resolveSubAgentDelegation, resolveSubAgentToolScope } from '../../utils/loop/loop-runtime'
import { prepareQueryLoopToolSchemaChars } from '../../utils/loop/loop-turn-assembly'
import {
  buildSubAgentReasoningOnlyVisibleAnswerRecoveryPrompt,
  buildSubAgentWindDownReminder,
  shouldRecoverReasoningOnlyEmptyResponse,
} from '../../utils/loop/loop-turn-recovery'
import { captureAgentTurnCapabilityContext, captureAgentTurnCapabilitySnapshot } from '../../utils/loop/turn-capability-snapshot'
import { resolveGovernanceSessionKey } from '../../utils/residency/session-key'
import { applyRunProfileToolExposure } from '../../utils/runner/run-profile'
import { resolveRunProfilePolicyForRuntime } from '../../utils/runner/runtime-profiles'
import { tickLoopReminders } from '../../utils/session/auto-verification'
import { DefaultModelInputModalities } from '../../utils/tools/model-input-policy'
import { AgentTuning } from '../../utils/tuning'
import { ChatRuntimeEvents } from '../../utils/wire/chat-runtime.js'
import { AgentLoopContextUsageManager } from '../context/AgentLoopContextUsageManager'
import { forkFileContext } from '../context/FileContextCoordinator'
import { KernelToolLoopGuard } from '../tools/KernelToolLoopGuard'

import { loopContinue, loopFinish, LoopWindDownGuard } from './LoopWindDownGuard'
import type { QueryTurnResult } from './QueryTurn'
import { isContextOverflowError, isContextOverflowReplayUnsafe } from './RetryPolicy'

/** 子 Agent 的提示词装配面：本 loop 只管什么时候要提示词，怎么拼由宿主注入的这一件决定。 */
interface QueryLoopRunContext<TContext extends QueryLoopToolContext, TSignals> {
  /**
   * 建本轮子 Agent 的 system prompt。每轮开头、在工具面定下来之后调一次（工具面会进提示词，顺序反了就对不上）。
   * 只读不写：不改历史、不碰工具上下文；抛错等于本轮失败，由 `execute` 冒泡给派发器。
   */
  buildSystemPrompt(args: {
    /** 本次会话的聊天配置（模型选择、开关等），用于挑提示词形态。 */
    chatConfig: AgentChatRuntimeConfig
    /** 系统级运行配置（语言、思考深度缺省、环境信息等）。 */
    systemConfig: AgentSystemRuntimeConfig
    /** 到本轮为止的完整历史；提示词可据此决定要不要复述任务。 */
    messages: ModelMessage[]
    /** 已锁定的目标角色解析结果（角色 id、默认工具、人格片段）。 */
    roleResolution: AgentRoleResolution
    /** 本轮的工具上下文快照，提示词按它列当前可用能力。 */
    toolContext: TContext
    /** 派发方给这个子 Agent 起的名字（有就用它自称），缺省用角色 id。 */
    identity?: string
    /** 代码等能力上下文信号；只有声明需要的角色才收集，其余传 null。 */
    capabilityContext: Nullable<TSignals>
    /** 本轮思考力度：派发方指定 ?? 系统设置。 */
    thinkingDepth?: LooseOptional<AgentSystemRuntimeConfig['thinkingDepth']>
    /** 是否目标模式。子 Agent 永远传 false——目标是父会话的状态，一次委派只是有界子任务。 */
    goalMode?: boolean
  }): Promise<{ systemPrompt: string }>
}

/** 一次委派锁定的模型运行时：整次子 Agent 运行都用这一份，中途不换模型。 */
interface QueryLoopRoleRuntime {
  /** 建模型实例的工厂：每轮发请求前用它把模型 id + 请求选项变成 SDK 能收的 model。 */
  provider: QueryTurnProvider
  /** 供应方 id（anthropic / openai / 托管服务等），进日志与 span 标注。 */
  providerId: string
  /** 对内对外统一的模型 id，也是用量与估算系数的索引键。 */
  model: string
  /** 供应方侧的真实模型名；经托管转发时可能与 `model` 不同，只用于观测。 */
  providerModel?: string
  /** 模型上下文窗口（token）。未知时（注入式派发）编辑预算与判档共用一个保守回退值。 */
  contextWindow?: number
  /** 模型吃得下的输入模态；工具目录据此滤掉结果它读不了的截图/音频类工具。 */
  supportedInputModalities: readonly AgentModelInputModality[]
  /** 温度、思考深度、providerOptions 等请求策略；逐轮原样透传给 turn。 */
  modelRequestOptions?: AgentModelRequestOptions
  /** 这份运行时是怎么定下来的，`injected` 表示派发方直接指定（team worker 路径）。 */
  resolutionSource: string
  /** 解析过程的留痕，原样交给调试面板；本 loop 不解读。 */
  resolutionTrace: readonly unknown[]
  /** 为什么退到了兜底模型（首选不可用时才有）；只用于解释，不影响执行。 */
  fallbackReason?: LooseOptional<string>
}

/** 模型运行时解析面（宿主注入）：本 loop 不认识具体 provider，只经它拿到可执行的模型。 */
interface QueryLoopRuntime {
  /** 由模型选择直接造一个 provider；派发方已自带 provider 时用不到这条路。 */
  createAgentProvider(input: unknown): QueryTurnProvider
  /**
   * 按聊天配置里的模型选择解析出本次委派的运行时。在首轮请求之前调一次，
   * 传入的 signal 一断即放弃解析；派发方给了 `runtimeOverride` 时整条路都不走。
   */
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown,
    signal?: AbortSignal
  ): Promise<QueryLoopRoleRuntime>
}

/** 回合执行面：本 loop 只经它发请求，实现是 `TurnRunner`（与主面同一实例）。 */
interface QueryLoopTurnRunner<
  TContext extends QueryLoopToolContext,
  TEvents extends QueryTurnEvents,
> {
  /**
   * 跑子 Agent 的一轮：返回时工具结果已在本轮内接回历史，本 loop 只看 `hasToolUse` 决定是否继续。
   * 抛错交给缺页恢复包装器处理，压不下去就终止本次委派。
   */
  executeQueryTurn(
    args: Omit<ExecuteQueryTurnArgs<TContext>, 'toolContext' | 'events'> & {
      /** 子 Agent 自己的工具上下文（由 `createSubAgentContext` 派生，带收窄后的工具面）。 */
      toolContext: TContext
      /** 事件面，缺省不投影界面；子 Agent 只在显式打开流式文本时才推 delta。 */
      events?: TEvents & QueryTurnEvents
    }
  ): Promise<QueryTurnResult>
  /** 子 Agent 能用的工具名单：在传入列表（或全量）基础上滤掉父级编排类工具，防止子 Agent 反向操纵父会话。 */
  getAllowedSubAgentTools(tools?: string[]): string[]
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
export interface QueryLoopApi<
  TContext extends QueryLoopToolContext = QueryLoopToolContext,
  TEvents extends QueryTurnEvents = QueryTurnEvents,
  TSignals = unknown,
> extends QueryLoopContract<TContext, TEvents, TSignals> {
  /**
   * 跑完一次子 Agent 委派，返回交回父 Agent 的最终文本（结构化输出模式下另经 `onStructuredOutput` 回调）。
   *
   * 谁调：`SubAgentDispatcher` 每次派发调一次，一次调用 = 一棵独立的 run span 树、一本独立的治理账本
   * （键是本次派发的 `contextEpochScope`，`finally` 里必定作废，不留到下次续跑）。
   * 一轮的次序：拿工具面快照 → 建 system prompt → `executeQueryTurn` → 累加用量、收敛 span →
   * 有工具调用就继续，没有就过收尾提醒与结构化输出校验后收尾。
   * 失败与中断：中止（父信号或 worker 信号）一律抛 `EXECUTION_ABORTED` 冒泡给派发器，不返回半成品；
   * 上下文超限先走一次「强开治理 epoch」再重试，压不下去就把原错误抛出；
   * 只出思考没有可见答复、结构化输出不合格各有有限次自纠，用尽即抛。
   * 达到运行软上限时不硬杀：注入收尾提醒，宽限轮用尽就带着当前进展正常返回。
   */
  execute(args: ExecuteQueryLoopArgs<TContext, TEvents, TSignals>): Promise<string>
}

class QueryLoop<
  TContext extends QueryLoopToolContext = QueryLoopToolContext,
  TEvents extends QueryTurnEvents = QueryTurnEvents,
  TSignals = unknown,
> implements QueryLoopApi<TContext, TEvents, TSignals>
{
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
    private readonly governanceSessions: ContextGovernanceSessionRegistryApi,
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
    private readonly seams: LooseOptional<AgentModSeamDispatcherApi> = null
  ) {
    this.executionLimits = resolveAgentExecutionLimits(executionLimitOverrides)
    this.contextUsage = new AgentLoopContextUsageManager(toolRegistry)
  }

  /** 执行一次子 Agent 委派任务。 */
  public async execute(args: ExecuteQueryLoopArgs<TContext, TEvents, TSignals>): Promise<string> {
    const toolLoopGuard = new KernelToolLoopGuard()
    const abortSignal = args.opts.workerAbortSignal
      ? AbortSignal.any([args.parentCtx.abortSignal, args.opts.workerAbortSignal])
      : args.parentCtx.abortSignal
    const startedAt = Date.now()
    const compiledStructuredOutput = args.opts.structuredOutputContract
      ? compileSubAgentOutputSchema(args.opts.structuredOutputContract.schema)
      : null
    const delegation = resolveSubAgentDelegation({
      task: args.task,
      opts: args.opts,
      parentRoleId: args.parentCtx.role.id,
    })
    const initialHistory = args.opts.initialHistory ?? []
    // 续跑时历史首条已是委派指令，再套一遍外壳只会把目标角色 / 授权分类 / 旧任务重复一遍白占上下文，
    // 所以追加指令原样接上；新派才把任务包进委派合约。
    const history: ModelMessage[] = isEmpty(initialHistory)
      ? [{ role: 'user', content: buildSubAgentInstruction(delegation) }]
      : [...initialHistory, createInternalFollowUpMessage(args.task)]
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
            args.opts.runtimeOverride.supportedInputModalities ?? DefaultModelInputModalities,
          modelRequestOptions: args.opts.runtimeOverride.modelRequestOptions,
          resolutionSource: 'injected',
          resolutionTrace: [],
        }
      : await this.runtimeHelper.resolveRoleRuntime(
          args.chatConfig.modelSelection,
          args.systemConfig.modelRuntimeContext,
          abortSignal
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
        randomUUID(),
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
      forkFileContext,
      requestToolCategories: args.opts.requestToolCategories,
      blockedToolNames: delegationPolicy.blockedToolNames,
      blockedCategoryIds: delegationPolicy.blockedCategoryIds,
    })
    childCtx.abortSignal = abortSignal
    childCtx.setSupportedModelInputModalities(roleRuntime.supportedInputModalities)
    // 子 Agent 同样下发输入侧可用窗口，让其编辑工具按自身模型窗口做编辑预算（缺省回退保守默认）。
    childCtx.codingSession.setUsableContextWindowTokens?.(
      resolveContextWindowBudget({
        contextWindow: roleRuntime.contextWindow ?? AgentTuning.loop.unknownContextWindowTokens,
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
      contextWindow: roleRuntime.contextWindow ?? AgentTuning.loop.unknownContextWindowTokens,
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
    let usageReasoningTokens: Nullable<number> = null
    let usageCacheReadInputTokens: Nullable<number> = null
    let usageCacheWriteInputTokens: Nullable<number> = null
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
        reasoningTokens: toOptional(usageReasoningTokens),
        cacheReadInputTokens: toOptional(usageCacheReadInputTokens),
        cacheWriteInputTokens: toOptional(usageCacheWriteInputTokens),
      })
    }

    // 观测（#37 阶段 C 片 2）：本次子 Agent 委派 = 一个独立顶层 run span，落父会话同一 span 账本、靠
    // sessionId 关联；带子 Agent 身份（identity/角色）与派发来源（父角色）标注，令同会话多 run 树可辨识。
    // 缺省端口时为 null（全链 no-op）。各终止分支就近收敛（scope.end 失败隔离、幂等首闭为准）。
    const runScope = toNullable(
      this.spanScopeFactory?.beginRun({
        runId: randomUUID(),
        sessionId: resolveGovernanceSessionKey(args.parentCtx.sessionId),
        // 子运行目前继承父会话，但不继承渲染层的消息信封。
        rootInputId: null,
        agentName: delegation.identity?.trim() || roleResolution.id,
        dispatchSource: args.parentCtx.role.id,
      })
    )

    const isAborted = (): boolean => abortSignal.aborted
    const assertRunning = (): void => {
      if (isAborted()) {
        throw new AppError('EXECUTION_ABORTED', '子 Agent 运行被终止。', abortSignal.reason)
      }
    }

    const runTurn = async (turn: number): Promise<LoopTurnVerdict<string>> => {
      await args.lifecycle?.beforeTurn?.({ turn, history, toolContext: childCtx, abortSignal: childCtx.abortSignal })
      assertRunning()
      const turnToolRegistry = captureAgentTurnCapabilitySnapshot(this.toolRegistry)
      const turnToolContext = captureAgentTurnCapabilityContext(childCtx)
      const supportedInputModalities = new Set(roleRuntime.supportedInputModalities)
      const candidateToolsForTurn = turnToolContext.getCurrentVisibleToolNames().filter(
        (toolName) =>
          (turnToolRegistry.getDescriptor(toolName)?.requiredModelInputModalities ?? []).every(
            (modality) => supportedInputModalities.has(modality)
          )
      )
      const candidateToolSchemaChars = prepareQueryLoopToolSchemaChars(
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
        turnToolRegistry,
        roleRuntime.modelRequestOptions
      )

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
            abortSignal,
            overflowRules: { isContextOverflowError, isContextOverflowReplayUnsafe },
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
                toolLoopGuard,
                toolRegistry: turnToolRegistry,
                allowedTools: allowedToolsForTurn,
                events: args.opts.events,
                streamTextDeltas: !!args.opts.streamTextDeltas,
                idleStallTimeoutMs: this.executionLimits.modelStreamIdleTimeoutMs,
                modelRetry: args.modelRetry,
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
            (args.modelRetry?.allowPartialContinuation ?? true) &&
            shouldRecoverReasoningOnlyEmptyResponse({
              error,
              phase: 'query',
              aborted:
                args.parentCtx.abortSignal.aborted || !!args.opts.workerAbortSignal?.aborted,
              recoveryAttempts: reasoningOnlyVisibleAnswerRecoveries,
              maxAttempts: AgentTuning.loop.reasoningOnlyAnswerRecoveryAttempts,
            })
          ) {
            reasoningOnlyVisibleAnswerRecoveries += 1
            history.push(
              createInternalFollowUpMessage(
                buildSubAgentReasoningOnlyVisibleAnswerRecoveryPrompt()
              )
            )
            args.opts.events?.emitRuntime(
              ChatRuntimeEvents.retryingTurn(
                turn,
                reasoningOnlyVisibleAnswerRecoveries,
                AgentTuning.loop.reasoningOnlyAnswerRecoveryAttempts,
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
            status: isAborted() ? 'aborted' : 'error',
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
        result.predictedInputTokens,
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
      if (isPresent(result.reasoningTokens)) {
        usageReasoningTokens = (usageReasoningTokens ?? 0) + result.reasoningTokens
      }
      if (isPresent(result.cacheReadInputTokens)) {
        usageCacheReadInputTokens = (usageCacheReadInputTokens ?? 0) + result.cacheReadInputTokens
      }
      if (isPresent(result.cacheWriteInputTokens)) {
        usageCacheWriteInputTokens = (usageCacheWriteInputTokens ?? 0) + result.cacheWriteInputTokens
      }

      const disposition = await args.lifecycle?.onTurnSettled?.({ turn, history, toolContext: childCtx, abortSignal: childCtx.abortSignal, result })
      assertRunning()
      if (disposition === 'stop') {
        args.opts.onHistoryUpdate?.(history)
        reportUsage()
        runScope?.end({ status: 'ok' })
        return loopFinish(result.text)
      }
      if (disposition === 'continue' && !result.hasToolUse) return loopContinue()

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
            if (
              structuredOutputRepairAttempts >=
              AgentTuning.loop.subAgentStructuredOutputRepairAttempts
            ) {
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
          history.push(createInternalFollowUpMessage(buildSubAgentWindDownReminder(startedAt)))
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
    } catch (error) {
      runScope?.end({ status: isAborted() ? 'aborted' : 'error' })
      assertRunning()
      throw error
    } finally {
      // 子 agent 的账本随本次运行结束即弃。这条消息序列之后**可能**再被编译：派发器按 threadId 续跑
      // 时用的是同一个键（contextEpochScope = threadId），届时账本从保留下来的历史重新摄入一遍——这笔
      // 重建成本可以接受。反过来把账本留到续跑保留期结束，就要长期占着 registry 的名额（每条线程一个
      // 键，长跑会话会把 128 个格子迅速填满，把真正长寿的父会话挤出去）。
      this.governanceSessions.invalidateSession(governanceSessionId)
    }
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
export type { QueryLoopRoleRuntime, QueryLoopRunContext, QueryLoopRuntime, QueryLoopTurnRunner }
