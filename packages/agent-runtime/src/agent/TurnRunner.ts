import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'

import { type AppError } from '@velaros-ai/core/error'

import { KernelContextEpochGuard } from '../kernel'

import type { ContextAttentionSessionRegistry } from './context'
import { sanitizeHistoryForProvider } from './history'
import {
  AgentTurnHistoryHelper,
  type AgentTurnToolExecutor,
  type AssistantContentPart,
} from './history'
import {
  type ExecuteQueryTurnArgs,
  QueryTurn,
  type QueryTurnResult,
  type QueryTurnToolContext,
  type QueryTurnToolRegistry,
} from './QueryTurn'
import { AgentConnectionRetryHelper } from './retry'
import type { StreamConsumerTurnState } from './stream'
import {
  type ExecuteStreamTurnArgs,
  StreamTurn,
  type StreamTurnResult,
  type StreamTurnToolContext,
  type StreamTurnToolRegistry,
} from './StreamTurn'

export type { ExecuteQueryTurnArgs, ExecuteStreamTurnArgs, QueryTurnResult, StreamTurnResult }

type TurnRunnerToolContext = QueryTurnToolContext & StreamTurnToolContext

type TurnRunnerToolRegistry<
  TToolContext extends TurnRunnerToolContext = TurnRunnerToolContext,
> = QueryTurnToolRegistry<TToolContext> &
  StreamTurnToolRegistry<TToolContext> & {
    names: Iterable<string>
  }

/**
 * Agent turn 门面。
 *
 * 这个类把 stream turn、query turn、history 拼接、连接重试等 helper 统一挂在一起。
 * 许多 private 方法是为了兼容旧测试/内部访问形态而保留的薄代理。
 */
class TurnRunner<TToolContext extends TurnRunnerToolContext = TurnRunnerToolContext> {
  /** 网络/连接类错误重试策略。 */
  private readonly connectionRetryHelper = new AgentConnectionRetryHelper()
  /** assistant/tool 消息历史拼接。 */
  private readonly turnHistoryHelper = new AgentTurnHistoryHelper()
  /** 非流式 query turn helper。 */
  private readonly queryTurnHelper: QueryTurn<TToolContext>
  /** 流式 stream turn helper。 */
  private readonly streamTurnHelper: StreamTurn<TToolContext>
  private readonly contextEpochGuard = new KernelContextEpochGuard()

  constructor(
    private readonly toolRegistry: TurnRunnerToolRegistry<TToolContext>,
    private readonly contextAttentionSessions: ContextAttentionSessionRegistry
  ) {
    this.queryTurnHelper = new QueryTurn(
      toolRegistry,
      this.turnHistoryHelper,
      this.contextAttentionSessions
    )
    this.streamTurnHelper = new StreamTurn(
      toolRegistry,
      this.connectionRetryHelper,
      this.turnHistoryHelper,
      this.contextAttentionSessions
    )
  }

  /** 执行一轮流式模型调用。 */
  public async executeStreamTurn(
    args: ExecuteStreamTurnArgs<TToolContext>
  ): Promise<StreamTurnResult> {
    // TODO[主链路-38]: turn 门面把“一轮流式模型调用”交给 StreamTurn，后者负责统一请求层调用和 assistant/tool 历史拼接。
    return this.streamTurnHelper.executeStreamTurn({
      ...args,
      contextEpochGuard: args.contextEpochGuard ?? this.contextEpochGuard,
    })
  }

  /** 等待工具执行完成，并把结果追加到 history。 */
  public async appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<void> {
    // TODO[主链路-39]: 工具调用完成后必须追加 tool result 到 history，下一轮模型才能看到工具输出。
    await this.turnHistoryHelper.appendToolResultsToHistory(history, executor)
  }

  /** 执行一轮子 Agent query 模型调用。 */
  public async executeQueryTurn(
    args: ExecuteQueryTurnArgs<TToolContext>
  ): Promise<QueryTurnResult> {
    return this.queryTurnHelper.executeQueryTurn({
      ...args,
      contextEpochGuard: args.contextEpochGuard ?? this.contextEpochGuard,
    })
  }

  /**
   * 子 Agent 默认可用全部工具；调用方可传入列表进一步收窄。
   * 过滤掉父级编排/用户交互/运行态变更类工具。子 Agent 可保留 ToolOS 内核和只读自救入口，
   * 但不能修改父级 goal/plan、扩展资源作用域、发起用户动作卡或切换父级运行档位。
   */
  public getAllowedSubAgentTools(tools?: string[]): string[] {
    const allowed = tools ? [...tools] : [...this.toolRegistry.names]
    return allowed.filter((toolName) => {
      const role = this.toolRegistry.getDescriptor(toolName)?.role
      return role !== 'control'
    })
  }

  private async consumeAssistantStream(
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
    turnState: StreamConsumerTurnState,
    args: Pick<
      ExecuteStreamTurnArgs<TToolContext>,
      'abortSignal' | 'executor' | 'events' | 'model' | 'toolContext'
    >
  ): Promise<AssistantContentPart[]> {
    return this.streamTurnHelper.consumeAssistantStream(fullStream, turnState, args)
  }

  private async runWithConnectionRetry<T>(
    operation: () => Promise<T>,
    options: {
      phase: 'stream' | 'query'
      turn: Nullable<number>
      abortSignal: AbortSignal
      hasVisibleOutput?: () => boolean
      hasToolUse?: () => boolean
      onRetry?: (error: AppError, attempt: number) => void
    }
  ): Promise<T> {
    return this.connectionRetryHelper.runWithConnectionRetry(operation, options)
  }

  private shouldRetryConnectionError(
    error: unknown,
    attempt: number,
    options: {
      abortSignal: AbortSignal
      hasVisibleOutput?: () => boolean
      hasToolUse?: () => boolean
    }
  ): boolean {
    return this.connectionRetryHelper.shouldRetryConnectionError(error, attempt, options)
  }

  private isTransientConnectionError(error: AppError): boolean {
    return this.connectionRetryHelper.isTransientConnectionError(error)
  }

  private buildErrorFingerprint(error: unknown, depth = 0): string {
    return this.connectionRetryHelper.buildErrorFingerprint(error, depth)
  }

  private getRetryDelayMs(_attempt: number, error?: unknown): number {
    return this.connectionRetryHelper.getRetryDelayMs(_attempt, error)
  }

  private appendAssistantMessage(
    history: ModelMessage[],
    assistantContent: AssistantContentPart[]
  ): void {
    this.turnHistoryHelper.appendAssistantMessage(history, assistantContent)
  }

  private sanitizeHistoryForProvider(
    history: ModelMessage[],
    phase: 'stream' | 'query',
    turn: Nullable<number>
  ): ModelMessage[] {
    return sanitizeHistoryForProvider(history, phase, turn)
  }
}

export { TurnRunner }
export { TurnRunner as AgentTurnHelper }
export type { TurnRunnerToolRegistry }
