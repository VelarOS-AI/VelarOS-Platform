import type { ModelMessage } from 'ai'

import type {
  AgentContextPhase,
  ChatPromptFeatureId,
  ExecutionModeId,
  PromptSegmentTrace,
  RunProfileId,
  SkippedPromptSegmentTrace,
} from '@velaros-ai/agent/protocol'

import {
  createSelectedSkillPromptSegment,
  createSkillPromptSegment,
  type PromptSegmentDefinition,
} from '../../prompts'
import type { RuntimePromptFeaturePolicy } from '../../tools'
import type { ContextBuilder } from '../ContextBuilder'
import {
  PromptStateBuilder,
  type PromptStatePreparedToolCategories,
  type PromptStateToolContext,
} from '../PromptState'
import type { AgentRoleResolution } from '../RoleTypes'
import type {
  AgentChatRuntimeConfig,
  AgentSystemRuntimeConfig,
} from '../RuntimeConfiguration'

import type { RunContextToolContext } from './host-ports'
import { type BuildTurnContextPayloadArgs, TurnPayload } from './TurnPayload'

interface BuildSystemPromptArgs {
  /** 聊天模型配置。 */
  chatConfig: AgentChatRuntimeConfig
  /** 系统配置。 */
  systemConfig: AgentSystemRuntimeConfig
  /** 当前消息历史。 */
  messages: ModelMessage[]
  /** 已解析角色。 */
  roleResolution: AgentRoleResolution
  /** 工具上下文。 */
  toolContext: RunContextToolContext
  /** 可选身份覆盖，常用于子智能体。 */
  identity?: string
  /** 代码上下文信号。 */
  capabilityContext?: unknown
  /** 用户选择的提示词特性（能力轴）。 */
  promptFeatures?: ChatPromptFeatureId[]
  preparedToolCategories?: PromptStatePreparedToolCategories
  /** 执行模式轴；缺席时读取点从旧形态折算。 */
  executionModes?: readonly ExecutionModeId[]
  goalMode?: boolean
  /** 本次请求使用的运行策略。 */
  thinkingDepth?: LooseOptional<AgentSystemRuntimeConfig['thinkingDepth']>
  runProfile?: LooseOptional<RunProfileId>
  promptBudget?: LooseOptional<{
    profile: RunProfileId
    maxChars: number
  }>
}

/** 系统提示词装配结果（常规/子智能体与主 Agent 两条入口共用的返回形状）。 */
interface AssembledSystemPrompt {
  systemPrompt: string
  devEnvironmentContext: Nullable<string>
  stableCutoff: number
  promptSegments: PromptSegmentTrace[]
  skippedPromptSegments: SkippedPromptSegmentTrace[]
}

/**
 * 智能体运行上下文构建器。
 *
 * 负责把角色、技能、运行时状态和能力包注入的上下文拼成最终系统提示词，
 * 同时生成轮次上下文调试载荷，供执行图/调试面板使用。
 */
class RunContext {
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

  /** 构建常规/子智能体系统提示词。 */
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
  }: BuildSystemPromptArgs): Promise<AssembledSystemPrompt> {
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

  /** 构建统一主 Agent 系统提示词。 */
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
    toolContext: RunContextToolContext
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
    toolContext: RunContextToolContext
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
      ...toolContext,
      // 计划/建议读取走非空交互会话端口：无 execution 的宿主降级为空计划，不再 `execution!` 撞 null。
      execution: toolContext.interaction,
      canDispatchSubAgents: !!toolContext.dispatchSubAgent,
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
    let builder = identity ? this.contextBuilder.withIdentity(identity) : this.contextBuilder
    for (const segment of roleSegments) {
      builder = builder.registerPromptSegment(segment)
    }
    for (const segment of runtimeState.segments) {
      builder = builder.registerPromptSegment(segment)
    }

    // build 会应用用户的 segmentOverrides，并返回追踪信息。
    const built = builder.build(
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

  /** 构建本轮轮次上下文载荷。 */
  public buildTurnContextPayload(args: BuildTurnContextPayloadArgs) {
    return this.turnContextPayloadBuilder.build(args)
  }

}

export { RunContext }
export { RunContext as AgentRunContextHelper }
