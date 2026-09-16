import { AppError } from '@velaros-ai/core/error'

import type { AgentExecutionStackApi, AgentExecutionStackWithQueryApi } from '../../contract/provides.js'
import type { AgentExecutionStackToolRegistry, RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { PromptRegistryApi } from '../../types/guidance.js'
import type { AgentExecutionLimits, ExecuteQueryLoopArgs, ExecuteSoloModeStreamLoopArgs, SoloModeStreamLoopResult } from '../../types/loop.js'
import type { ExecutionEventBusApi } from '../../types/records.js'
import type { ContextGovernanceSessionRegistryApi } from '../../types/residency.js'
import type { AgentExecutionStackOptions, AgentExecutionStackRunnerOptions, AgentExecutionStackToolContext, AgentRunnerApi } from '../../types/runner.js'
import { resolveAgentExecutionLimits } from '../../utils/loop/execution-limits'
import { createBuiltInPromptRegistry } from '../guidance/PromptRegistry'
import { QueryLoop } from '../loop/QueryLoop'
import { SoloStreamLoop } from '../loop/SoloStreamLoop'
import { TurnRunner } from '../loop/TurnRunner'
import { ContextGovernanceSessionRegistry } from '../residency/ContextGovernanceSessionRegistry'
import { AgentRunner } from '../runner/AgentRunner'
import { ContextBuilder } from '../runner/ContextBuilder'
import { ModelRuntime } from '../runner/ModelRuntime'
import { RunContext } from '../runner/RunContext'
import { defaultRuntimePromptFeaturePolicy } from '../tools/DefaultPromptFeaturePolicy'

/**
 * 建栈时一次配齐、之后不再变的内件：由 `createAgentExecutionStack` 从产品给的 options 解析出来交给栈。
 * 栈只持有它们、不替换；`queryLoop` 缺席就表示这份栈只跑 Solo。
 */
export interface AgentExecutionStackParts<TContext extends AgentExecutionStackToolContext> {
  /** 本栈用的提示词目录：产品给了用产品的，没给用包内置的那一份。 */
  readonly promptRegistry: PromptRegistryApi
  /** 上下文治理的会话登记处；宿主想跨栈共享会话生命周期就注入同一个实例，否则是本栈独占的一份。 */
  readonly governanceSessions: ContextGovernanceSessionRegistryApi
  /** 本栈绑定的那一份工具面；建 Runner 时原样传下去，保证两个执行面看到的工具集合一致。 */
  readonly toolRegistry: AgentExecutionStackToolRegistry<TContext>
  /** 提示词特性（思考深度、执行模式等）的取舍策略；Runner 的 codingSessionPolicy 一律用它，避免两个面各持一份。 */
  readonly promptFeaturePolicy: RuntimePromptFeaturePolicy
  /** 解析过缺省值的执行上限（主面/子面的最大轮次等）；两个循环与 Runner 共用这一份结论。 */
  readonly executionLimits: AgentExecutionLimits
  /** 主 Agent 的流式循环，Solo 面与 Runner 的主面用的是同一个实例。 */
  readonly soloLoop: SoloStreamLoop<TContext, ExecutionEventBusApi>
  /** 子 Agent 查询循环；建栈时没给 `options.query` 就缺席，此时查询面一调即抛 `INVALID_STATE`。 */
  readonly queryLoop?: QueryLoop<TContext, ExecutionEventBusApi>
}

class AgentExecutionStack<
  TContext extends AgentExecutionStackToolContext = AgentExecutionStackToolContext,
> implements AgentExecutionStackWithQueryApi<TContext> {
  public readonly promptRegistry: PromptRegistryApi
  public readonly governanceSessions: ContextGovernanceSessionRegistryApi
  private readonly toolRegistry: AgentExecutionStackToolRegistry<TContext>
  private readonly promptFeaturePolicy: RuntimePromptFeaturePolicy
  private readonly executionLimits: AgentExecutionLimits
  private readonly soloLoop: SoloStreamLoop<TContext, ExecutionEventBusApi>
  private readonly queryLoop: LooseOptional<QueryLoop<TContext, ExecutionEventBusApi>>

  public constructor(parts: AgentExecutionStackParts<TContext>) {
    this.promptRegistry = parts.promptRegistry
    this.governanceSessions = parts.governanceSessions
    this.toolRegistry = parts.toolRegistry
    this.promptFeaturePolicy = parts.promptFeaturePolicy
    this.executionLimits = parts.executionLimits
    this.soloLoop = parts.soloLoop
    this.queryLoop = parts.queryLoop
  }

  public executeSolo(
    args: ExecuteSoloModeStreamLoopArgs<TContext, ExecutionEventBusApi>
  ): Promise<SoloModeStreamLoopResult> {
    return this.soloLoop.execute(args)
  }

  public clearSession(sessionId: string): void {
    this.soloLoop.clearSession(sessionId)
    this.governanceSessions.invalidateSession(sessionId)
  }

  public async executeQuery(
    args: ExecuteQueryLoopArgs<TContext, ExecutionEventBusApi>
  ): Promise<string> {
    return this.requireQueryLoop().execute(args)
  }

  public createRunner(options: AgentExecutionStackRunnerOptions<TContext>): AgentRunnerApi<TContext> {
    const queryLoop = this.requireQueryLoop()
    const {
      contextHelper,
      primaryAgentProfile,
      subAgentDispatcher,
      executionEnvironment,
      codingSessionPolicy,
      ...infrastructure
    } = options
    const runner = new AgentRunner<TContext>(
      {
        contextHelper,
        primaryAgentProfile,
        subAgentDispatcher,
        primaryAgentStreamLoop: this.soloLoop,
        queryLoop,
      },
      { executionEnvironment },
      {
        ...infrastructure,
        toolRegistry: this.toolRegistry,
        executionLimitOverrides: this.executionLimits,
        codingSessionPolicy: { ...codingSessionPolicy, promptFeaturePolicy: this.promptFeaturePolicy },
      }
    )
    subAgentDispatcher.bindAgentRunner(runner)
    return runner
  }

  /**
   * 查询面的唯一取用口：没配 query 的栈在这里就拦下来，而不是让调用点拿到 undefined 再炸在别处。
   * 建栈时的取舍是产品的决定，所以这是 `INVALID_STATE` 而不是运行期故障。
   */
  private requireQueryLoop(): QueryLoop<TContext, ExecutionEventBusApi> {
    if (!this.queryLoop) {
      throw new AppError(
        'INVALID_STATE',
        '这份执行栈建栈时没给 query 配置，只能跑 Solo；要用 executeQuery / createRunner，请在 createAgentExecutionStack 的 options.query 里给出 roleEngine 与 getToolNamesForCategories。'
      )
    }
    return this.queryLoop
  }
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
): AgentExecutionStackWithQueryApi<TContext>
export function createAgentExecutionStack<
  TContext extends AgentExecutionStackToolContext = AgentExecutionStackToolContext,
>(options: AgentExecutionStackOptions<TContext>): AgentExecutionStackApi<TContext>
export function createAgentExecutionStack<
  TContext extends AgentExecutionStackToolContext = AgentExecutionStackToolContext,
>(
  options: AgentExecutionStackOptions<TContext>
): AgentExecutionStackApi<TContext> | AgentExecutionStackWithQueryApi<TContext> {
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
  const parts: AgentExecutionStackParts<TContext> = {
    promptRegistry,
    governanceSessions,
    toolRegistry: options.toolRegistry,
    promptFeaturePolicy,
    executionLimits,
    soloLoop,
  }
  if (!queryLoop) return new AgentExecutionStack<TContext>(parts)
  return new AgentExecutionStack<TContext>({ ...parts, queryLoop })
}
