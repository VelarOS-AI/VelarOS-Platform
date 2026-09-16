import type { ExecutionEventBusApi } from '../../types/records.js'
import type { AgentExecutionStack, AgentExecutionStackOptions, AgentExecutionStackToolContext, AgentExecutionStackWithQuery } from '../../types/runner.js'
import { createBuiltInPromptRegistry } from '../../utils/guidance/catalog'
import { resolveAgentExecutionLimits } from '../../utils/loop/execution-limits'
import { QueryLoop } from '../loop/QueryLoop'
import { SoloStreamLoop } from '../loop/SoloStreamLoop'
import { TurnRunner } from '../loop/TurnRunner'
import { ContextGovernanceSessionRegistry } from '../residency/ContextGovernanceSession'
import { AgentRunner } from '../runner/AgentRunner'
import { ContextBuilder } from '../runner/ContextBuilder'
import { ModelRuntime } from '../runner/ModelRuntime'
import { RunContext } from '../runner/RunContext'
import { defaultRuntimePromptFeaturePolicy } from '../tools/DefaultPromptFeaturePolicy'

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
  const soloLoop = new SoloStreamLoop<TContext, ExecutionEventBusApi>(
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
    ? new QueryLoop<TContext, ExecutionEventBusApi>(
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
