import type { ModelMessage } from 'ai'

import type { AgentChatRuntimeConfig, AgentSystemRuntimeConfig, RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type {
  AgentContextPhase,
  ChatPromptFeatureId,
  ExecutionModeId,
  StreamTurnContextPayload,
} from '../../types/agent'
import type { RunProfileId } from '../../types/agent.js'
import type { PromptSegmentDefinition } from '../../types/guidance.js'
import type { AgentRoleResolution, AssembledSystemPrompt, BuildSystemPromptArgs, BuildTurnContextPayloadArgs,PromptStatePreparedToolCategories, PromptStateToolContext, RunContextToolContext } from '../../types/runner.js'
import {
  createSelectedSkillPromptSegment,
  createSkillPromptSegment,
} from '../../utils/guidance/shared'

import type { ContextBuilder } from './ContextBuilder'
import { PromptStateBuilder } from './PromptStateBuilder'
import { TurnPayload } from './TurnPayload'

/**
 * 智能体运行上下文构建器。
 *
 * 负责把角色、技能、运行时状态和能力包注入的上下文拼成最终系统提示词，
 * 同时生成轮次上下文调试载荷，供执行图/调试面板使用。
 *
 * 由执行栈在装配期建一份、整条运行链复用；本身不存回合状态，每次调用都按传入的历史与开关重新装配。
 */
export interface RunContextApi<TContext extends RunContextToolContext = RunContextToolContext> {
  /**
   * 装配常规/子智能体这条入口的系统提示词：注入角色技能段（角色全文 + 命中的 skill 指针），不做阶段门控。
   * `identity` 给子 Agent 换身份用。返回的 `AssembledSystemPrompt` 同时带着进/未进提示词的段落 trace。
   */
  buildSystemPrompt(args: BuildSystemPromptArgs<TContext>): Promise<AssembledSystemPrompt>
  /**
   * 装配统一主 Agent 的系统提示词：主 Agent 没有角色 Skill，只在 `contextPhase === 'operational'` 这一阶段
   * 注入本轮命中的能力 Skill 指针与编码召回；其余装配步骤与 `buildSystemPrompt` 完全同一条路径。
   */
  buildPrimaryAgentSystemPrompt(
    args: Omit<BuildSystemPromptArgs<TContext>, 'identity'> & { contextPhase: AgentContextPhase }
  ): Promise<AssembledSystemPrompt>
  /**
   * 生成本轮的轮次上下文调试载荷（真正送进模型的系统提示词、可见工具、消息快照等）。
   * 只供调试面板与执行图展示，不参与推理，因此失败也不该影响这一轮的执行。
   */
  buildTurnContextPayload(
    args: Omit<BuildTurnContextPayloadArgs, 'toolContext'> & { toolContext: TContext }
  ): StreamTurnContextPayload
}

class RunContext<TContext extends RunContextToolContext = RunContextToolContext>
  implements RunContextApi<TContext> {
  /** 构建轮次上下文调试载荷。 */
  private readonly turnContextPayloadBuilder = new TurnPayload()
  /** 收集运行时提示词片段，例如工具提示、系统状态、开发环境上下文。 */
  private readonly runtimePromptStateBuilder: PromptStateBuilder

  constructor(
    /** 分段系统提示词构建器。 */
    private readonly contextBuilder: ContextBuilder,
    /** 提示词特性策略（宿主注入；把 core 常量层映射适配成运行态形状）。 */
    promptFeaturePolicy: RuntimePromptFeaturePolicy,
    /** 已安装的文件式自定义子智能体列表（注入 dispatch 提示词段）。 */
    listCustomSubAgents?: () => Array<{ id: string; description: string; base: string }>
  ) {
    this.runtimePromptStateBuilder = new PromptStateBuilder(
      promptFeaturePolicy,
      listCustomSubAgents
    )
  }

  public async buildSystemPrompt({
    chatConfig,
    systemConfig,
    messages,
    roleResolution,
    toolContext,
    identity,
    capabilityContext,
    promptFeatures,
    preparedToolCategories,
    executionModes,
    goalMode,
    thinkingDepth,
    runProfile,
    promptBudget,
  }: BuildSystemPromptArgs<TContext>): Promise<AssembledSystemPrompt> {
    const effectiveThinkingDepth = thinkingDepth ?? systemConfig.thinkingDepth
    // 角色行为单一来源：只注入角色技能段（BuiltinRole 全文 + 命中 skill 指针），不再另发角色 systemPrompt。
    // 常规/子智能体入口无阶段门控（contextPhase 缺省），编码召回只看空间根绑定。
    return this.assembleSystemPrompt({
      chatConfig,
      systemConfig,
      messages,
      roleResolution,
      toolContext,
      capabilityContext,
      promptFeatures,
      preparedToolCategories,
      executionModes,
      goalMode,
      effectiveThinkingDepth,
      runProfile,
      promptBudget,
      identity,
      roleSegments: [createSkillPromptSegment(roleResolution.id, roleResolution.skillMarkdown)],
    })
  }

  public async buildPrimaryAgentSystemPrompt({
    chatConfig,
    systemConfig,
    messages,
    roleResolution,
    toolContext,
    capabilityContext,
    promptFeatures,
    preparedToolCategories,
    executionModes,
    goalMode,
    thinkingDepth,
    runProfile,
    promptBudget,
    contextPhase,
  }: {
    chatConfig: AgentChatRuntimeConfig
    systemConfig: AgentSystemRuntimeConfig
    messages: ModelMessage[]
    roleResolution: AgentRoleResolution
    toolContext: TContext
    capabilityContext?: unknown
    thinkingDepth?: LooseOptional<AgentSystemRuntimeConfig['thinkingDepth']>
    promptFeatures?: ChatPromptFeatureId[]
    preparedToolCategories?: PromptStatePreparedToolCategories
    executionModes?: readonly ExecutionModeId[]
    goalMode?: boolean
    runProfile?: LooseOptional<RunProfileId>
    contextPhase: AgentContextPhase
    promptBudget?: LooseOptional<{
      profile: RunProfileId
      maxChars: number
    }>
  }): Promise<AssembledSystemPrompt> {
    const effectiveThinkingDepth = thinkingDepth ?? systemConfig.thinkingDepth
    // 主 Agent 没有角色 Skill；只在 operational 阶段注入本轮命中的能力 Skill 指针，编码召回也仅此阶段生效。
    return this.assembleSystemPrompt({
      chatConfig,
      systemConfig,
      messages,
      roleResolution,
      toolContext,
      capabilityContext,
      promptFeatures,
      preparedToolCategories,
      executionModes,
      goalMode,
      effectiveThinkingDepth,
      runProfile,
      promptBudget,
      contextPhase,
      roleSegments:
        contextPhase === 'operational'
          ? [createSelectedSkillPromptSegment(roleResolution.skillMarkdown)]
          : [],
    })
  }

  /**
   * 系统提示词装配单源：常规/子智能体与主 Agent 两条入口共用。差异只在装配前由调用方决定——
   * `identity`、角色技能段 `roleSegments`、以及 `contextPhase`（缺省 = 常规入口，无阶段门控；
   * 传入则按阶段门控编码召回并透传给 runtimeState）。其余装配步骤（工具上下文降级、runtimeState、
   * 编码召回/策略/护栏分段、build 与追踪）完全一致。
   */
  private async assembleSystemPrompt({
    chatConfig,
    systemConfig,
    messages,
    roleResolution,
    toolContext,
    capabilityContext: _capabilityContext,
    promptFeatures,
    preparedToolCategories,
    executionModes,
    goalMode,
    effectiveThinkingDepth,
    runProfile,
    promptBudget,
    contextPhase,
    identity,
    roleSegments,
  }: {
    chatConfig: AgentChatRuntimeConfig
    systemConfig: AgentSystemRuntimeConfig
    messages: ModelMessage[]
    roleResolution: AgentRoleResolution
    toolContext: TContext
    capabilityContext?: unknown
    promptFeatures?: ChatPromptFeatureId[]
    preparedToolCategories?: PromptStatePreparedToolCategories
    executionModes?: readonly ExecutionModeId[]
    goalMode?: boolean
    effectiveThinkingDepth: AgentSystemRuntimeConfig['thinkingDepth']
    runProfile?: LooseOptional<RunProfileId>
    promptBudget?: LooseOptional<{
      profile: RunProfileId
      maxChars: number
    }>
    contextPhase?: AgentContextPhase
    identity?: string
    roleSegments: PromptSegmentDefinition[]
  }): Promise<AssembledSystemPrompt> {
    const promptToolContext: PromptStateToolContext = {
      // 冻结的 turn context 通过原型继承宿主能力，展开对象会丢失这些端口。
      locale: toolContext.locale,
      sessionId: toolContext.sessionId,
      developerContext: toolContext.developerContext,
      agentSurfaceId: toolContext.agentSurfaceId,
      capabilityPorts: toolContext.capabilityPorts,
      codingSession: toolContext.codingSession,
      skills: toolContext.skills,
      listToolCategories: (scope) => toolContext.listToolCategories(scope),
      // 计划/建议读取走非空交互会话端口：无 execution 的宿主降级为空计划，不再 `execution!` 撞 null。
      execution: toolContext.interaction,
      canDispatchSubAgents: !!toolContext.dispatchSubAgent,
      getSubAgentDispatchCatalog: toolContext.getSubAgentDispatchCatalog
        ? () => toolContext.getSubAgentDispatchCatalog!()
        : undefined,
    }
    // runtimeState 包含运行时事实、动态提示词片段和开发环境摘要。
    // contextPhase 缺省时透传 undefined，runtimeState.build 内部默认回落 'operational'（与常规入口原行为一致）。
    const runtimeState = await this.runtimePromptStateBuilder.build({
      toolContext: promptToolContext,
      roleResolution,
      messages,
      selectedPromptFeatures: promptFeatures,
      preparedToolCategories,
      executionModes,
      goalMode,
      thinkingDepth: effectiveThinkingDepth,
      runProfile,
      contextPhase,
    })
    // 角色与运行时贡献只属于当前一轮；共享宿主注册表只保留配置时安装的段和 provider。
    const builder = (identity ? this.contextBuilder.withIdentity(identity) : this.contextBuilder)
      .withPromptSegments([...roleSegments, ...runtimeState.segments])

    // build 会应用用户的 segmentOverrides，并返回追踪信息。
    const built = await builder.buildAsync(
      chatConfig,
      {
        facts: runtimeState.facts,
        overrides: systemConfig.prompt.segmentOverrides,
      },
      {
        promptBudget,
      }
    )

    return {
      systemPrompt: built.systemPrompt,
      stableCutoff: built.stableCutoff,
      promptSegments: built.segments,
      skippedPromptSegments: built.skippedSegments,
      devEnvironmentContext: runtimeState.devEnvironmentContext,
    }
  }

  public buildTurnContextPayload(args: Omit<BuildTurnContextPayloadArgs, 'toolContext'> & { toolContext: TContext }): StreamTurnContextPayload {
    return this.turnContextPayloadBuilder.build(args)
  }

}

export { RunContext }
export { RunContext as AgentRunContextHelper }
