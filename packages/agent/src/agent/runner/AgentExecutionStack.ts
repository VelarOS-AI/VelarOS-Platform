import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import type { ExecutionSpanScopeFactory } from '../../kernel/observability'
import type { AgentModSeamDispatcher } from '../../mods/AgentModSeams'
import { createBuiltInPromptRegistry, type PromptRegistry } from '../../prompts'
import {
  defaultRuntimePromptFeaturePolicy,
  type RuntimePromptFeaturePolicy,
} from '../../tools/prompt-feature-policy'
import { ContextGovernanceSessionRegistry } from '../context/residency/ContextGovernanceSession'
import { ContextBuilder } from '../ContextBuilder'
import { type AgentExecutionLimitOverrides, resolveAgentExecutionLimits } from '../ExecutionLimits'
import type { AgentModelResolverPort } from '../model/ModelContracts'
import type { PrimaryAgentProfile } from '../PrimaryAgentProfile'
import {
  type ExecuteQueryLoopArgs,
  QueryLoop,
  type QueryLoopRoleEngine,
  type QueryLoopToolCategoryResolver,
  type QueryLoopToolRegistry,
} from '../QueryLoop'
import type { RunContextToolContext } from '../run-context/host-ports'
import { RunContext } from '../run-context/RunContext'
import {
  type ExecuteSoloModeStreamLoopArgs,
  type SoloLoopToolRegistry,
  type SoloModeStreamLoopResult,
  SoloStreamLoop,
} from '../SoloLoop'
import { TurnRunner, type TurnRunnerToolRegistry } from '../TurnRunner'

import { AgentRunner } from './AgentRunner'
import type { AgentRunnerInfrastructure } from './AgentRunnerTypes'
import type {
  RunnerCodingSessionPolicyBundle,
  RunnerExecutionEnvironmentPort,
  RunnerSubAgentDispatcher,
  RunnerToolContext,
  RunnerToolContextBuilder,
} from './host-ports'
import { ModelRuntime } from './ModelRuntime'

/** 默认执行栈真正读取的工具与提示词端口；产品可以结构化提供更宽的上下文。 */
export type AgentExecutionStackToolContext = RunnerToolContext & RunContextToolContext

export type AgentExecutionStackToolRegistry<TContext extends AgentExecutionStackToolContext> =
  SoloLoopToolRegistry<TContext> &
    QueryLoopToolRegistry<TContext> &
    TurnRunnerToolRegistry<TContext>

export interface AgentExecutionStackOptions<TContext extends AgentExecutionStackToolContext> {
  model: AgentModelResolverPort
  toolRegistry: AgentExecutionStackToolRegistry<TContext>
  /** 共享宿主会话生命周期时注入；缺省为此栈独占登记处。 */
  governanceSessions?: ContextGovernanceSessionRegistry
  promptRegistry?: PromptRegistry
  promptFeaturePolicy?: RuntimePromptFeaturePolicy
  listCustomSubAgents?: () => Array<{ id: string; description: string; base: string }>
  spanScopeFactory?: LooseOptional<ExecutionSpanScopeFactory>
  executionLimitOverrides?: AgentExecutionLimitOverrides
  seams?: LooseOptional<AgentModSeamDispatcher>
  /** 只运行 Solo 的宿主省略此项；不会创建 QueryLoop 或默认启用子 Agent。 */
  query?: {
    roleEngine: QueryLoopRoleEngine
    getToolNamesForCategories: QueryLoopToolCategoryResolver
  }
}

export interface AgentExecutionStackRunnerOptions<
  TContext extends AgentExecutionStackToolContext,
> extends Omit<
  AgentRunnerInfrastructure,
  'toolRegistry' | 'executionLimitOverrides' | 'codingSessionPolicy'
> {
  contextHelper: RunnerToolContextBuilder<TContext>
  primaryAgentProfile: PrimaryAgentProfile
  subAgentDispatcher: RunnerSubAgentDispatcher<TContext> & {
    bindAgentRunner(runner: Pick<AgentRunner<TContext>, 'query'>): void
  }
  executionEnvironment?: RunnerExecutionEnvironmentPort
  /** 提示词策略取自栈配置，避免两个执行面或 Runner 各持一份。 */
  codingSessionPolicy: Omit<RunnerCodingSessionPolicyBundle, 'promptFeaturePolicy'>
}

export interface AgentExecutionStack<TContext extends AgentExecutionStackToolContext> {
  readonly promptRegistry: PromptRegistry
  readonly governanceSessions: ContextGovernanceSessionRegistry
  executeSolo(
    args: ExecuteSoloModeStreamLoopArgs<TContext, ExecutionEventBus>
  ): Promise<SoloModeStreamLoopResult>
  /** 删除/替换宿主会话时调用，释放本栈的会话状态及治理账本。 */
  clearSession(sessionId: string): void
}

export interface AgentExecutionStackWithQuery<
  TContext extends AgentExecutionStackToolContext,
> extends AgentExecutionStack<TContext> {
  executeQuery(args: ExecuteQueryLoopArgs<TContext, ExecutionEventBus>): Promise<string>
  createRunner(options: AgentExecutionStackRunnerOptions<TContext>): AgentRunner<TContext>
}

/**
 * 默认执行栈的唯一装配入口。产品注入能力与策略，包内配对上下文、回合、Solo/Query 与 Runner。
 * 每份栈绑定一份工具面；工具面整体替换时应创建新栈，治理登记处可由宿主继续共享。
 */
export function createAgentExecutionStack<
  TContext extends AgentExecutionStackToolContext = AgentExecutionStackToolContext,
>(
  options: AgentExecutionStackOptions<TContext> & {
    query: NonNullable<AgentExecutionStackOptions<TContext>['query']>
  }
): AgentExecutionStackWithQuery<TContext>
export function createAgentExecutionStack<
  TContext extends AgentExecutionStackToolContext = AgentExecutionStackToolContext,
>(options: AgentExecutionStackOptions<TContext>): AgentExecutionStack<TContext>
export function createAgentExecutionStack<
  TContext extends AgentExecutionStackToolContext = AgentExecutionStackToolContext,
>(
  options: AgentExecutionStackOptions<TContext>
): AgentExecutionStack<TContext> | AgentExecutionStackWithQuery<TContext> {
  const promptRegistry = options.promptRegistry ?? createBuiltInPromptRegistry()
  const governanceSessions = options.governanceSessions ?? new ContextGovernanceSessionRegistry()
  const promptFeaturePolicy = options.promptFeaturePolicy ?? defaultRuntimePromptFeaturePolicy
  const executionLimits = resolveAgentExecutionLimits(options.executionLimitOverrides)
  const modelRuntime = new ModelRuntime(options.model)
  const turnRunner = new TurnRunner<TContext>(options.toolRegistry, governanceSessions)
  const runContext = new RunContext<TContext>(
    new ContextBuilder(promptRegistry, options.seams),
    promptFeaturePolicy,
    options.listCustomSubAgents
  )
  const soloLoop = new SoloStreamLoop<TContext, ExecutionEventBus>(
    modelRuntime,
    turnRunner,
    governanceSessions,
    runContext,
    options.toolRegistry,
    options.spanScopeFactory,
    executionLimits,
    options.seams
  )
  const queryLoop = options.query
    ? new QueryLoop<TContext, ExecutionEventBus>(
        modelRuntime,
        turnRunner,
        governanceSessions,
        runContext,
        options.query.roleEngine,
        options.toolRegistry,
        options.query.getToolNamesForCategories,
        options.spanScopeFactory,
        executionLimits,
        options.seams
      )
    : undefined
  const soloStack: AgentExecutionStack<TContext> = {
    promptRegistry,
    governanceSessions,
    executeSolo: (args) => soloLoop.execute(args),
    clearSession: (sessionId) => {
      soloLoop.clearSession(sessionId)
      governanceSessions.invalidateSession(sessionId)
    },
  }
  if (!queryLoop) return soloStack
  return {
    ...soloStack,
    executeQuery: (args) => queryLoop.execute(args),
    createRunner: ({
      contextHelper,
      primaryAgentProfile,
      subAgentDispatcher,
      executionEnvironment,
      codingSessionPolicy,
      ...infrastructure
    }) => {
      const runner = new AgentRunner<TContext>(
        {
          contextHelper,
          primaryAgentProfile,
          subAgentDispatcher,
          primaryAgentStreamLoop: soloLoop,
          queryLoop,
        },
        { executionEnvironment },
        {
          ...infrastructure,
          toolRegistry: options.toolRegistry,
          executionLimitOverrides: executionLimits,
          codingSessionPolicy: { ...codingSessionPolicy, promptFeaturePolicy },
        }
      )
      subAgentDispatcher.bindAgentRunner(runner)
      return runner
    },
  }
}
