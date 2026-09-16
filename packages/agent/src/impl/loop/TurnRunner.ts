import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'

import { type AppError } from '@velaros-ai/core/error'

import type { AgentTurnToolExecutor, AgentTurnToolResult, AssistantContentPart } from '../../types/history.js'
import type { ExecuteQueryTurnArgs, ExecuteStreamTurnArgs, StreamTurnResult, TurnRunnerToolContext, TurnRunnerToolRegistry } from '../../types/loop.js'
import type { ContextGovernanceSessionRegistryApi } from '../../types/residency.js'
import { TurnHistory } from '../records/TurnHistory'

import { KernelContextEpochGuard } from './KernelContextEpochGuard'
import { QueryTurn, type QueryTurnResult } from './QueryTurn'
import { AgentConnectionRetryHelper } from './RetryPolicy'
import type { StreamConsumerTurnState } from './StreamConsumer'
import { StreamTurn } from './StreamTurn'

export type { ExecuteQueryTurnArgs, ExecuteStreamTurnArgs, QueryTurnResult, StreamTurnResult }

/**
 * 回合门面：两个 loop 面（主面 `SoloStreamLoop`、子面 `QueryLoop`）唯一的「发一轮模型请求」入口。
 *
 * 谁建：`AgentExecutionStack` 组装时建一个，两个面共用同一实例；它自己持有连接重试、历史拼接、
 * 流式/非流式两个 turn helper，以及**一份上下文纪元看门人**——纪元跨主面与子面共享一格账，
 * 正是靠这一份实例保证父子并发时后来者作废在途请求。
 * 一轮里的次序：面准备好 system/history/tools → 调 `executeStreamTurn`（或子面的 `executeQueryTurn`）→
 * 有工具调用则（主面）再调 `appendToolResultsToHistory` 把结果接回历史 → 进下一轮。
 * 失败与中断：本门面不吞错也不判重试，异常原样冒泡给面去收敛；中断走 args 里的 abortSignal，
 * 取消时 turn helper 丢弃未完成的 assistant 内容，避免留下没有 tool-result 的孤儿 tool-call。
 */
export interface TurnRunnerApi<TToolContext extends TurnRunnerToolContext = TurnRunnerToolContext> {
  /**
   * 执行一轮流式模型调用（主面）。内部含连接重试与续写恢复，返回时本轮 assistant 内容已写回历史，
   * 工具调用已排进传入的 executor；args 没带纪元看门人时用本门面自己那一份。
   */
  executeStreamTurn(args: ExecuteStreamTurnArgs<TToolContext>): Promise<StreamTurnResult>
  /**
   * 等这一轮排进 executor 的工具全部执行完，把 tool result 追加进 history，并返回结果清单。
   * 必须在下一轮请求之前调：少了这一步，历史里的 tool-call 就没有配对结果，下一轮请求会被 provider 拒绝。
   */
  appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<AgentTurnToolResult[]>
  /**
   * 执行一轮子 Agent 调用。与流式轮的差别是不投影界面、且工具结果在本轮内就接回历史，
   * 调用方不用再调 `appendToolResultsToHistory`。
   */
  executeQueryTurn(args: ExecuteQueryTurnArgs<TToolContext>): Promise<QueryTurnResult>
  /**
   * 子 Agent 本轮可用的工具名单：不传就是全量工具，传了就在它之上再收窄；
   * 两种情况都会滤掉 `role === 'control'` 的父级编排类工具（改父目标、切运行档、发用户动作卡等）。
   */
  getAllowedSubAgentTools(tools?: string[]): string[]
}

/**
 * Agent turn 门面。
 *
 * 这个类把 stream turn、query turn、history 拼接、连接重试等 helper 统一挂在一起。
 * 许多 private 方法是为了兼容旧测试/内部访问形态而保留的薄代理。
 */
class TurnRunner<TToolContext extends TurnRunnerToolContext = TurnRunnerToolContext>
  implements TurnRunnerApi<TToolContext>
{
  /** 网络/连接类错误重试策略。 */
  private readonly connectionRetryHelper = new AgentConnectionRetryHelper()
  /** assistant/tool 消息历史拼接。 */
  private readonly turnHistoryHelper = new TurnHistory()
  /** 非流式 query turn helper。 */
  private readonly queryTurnHelper: QueryTurn<TToolContext>
  /** 流式 stream turn helper。 */
  private readonly streamTurnHelper: StreamTurn<TToolContext>
  private readonly contextEpochGuard = new KernelContextEpochGuard()

  constructor(
    private readonly toolRegistry: TurnRunnerToolRegistry<TToolContext>,
    /** 治理会话登记处（宿主级单实例，驻留账本跨回合的家）。 */
    private readonly governanceSessions: ContextGovernanceSessionRegistryApi
  ) {
    this.queryTurnHelper = new QueryTurn(
      toolRegistry,
      this.turnHistoryHelper,
      this.governanceSessions
    )
    this.streamTurnHelper = new StreamTurn(
      toolRegistry,
      this.connectionRetryHelper,
      this.turnHistoryHelper,
      this.governanceSessions
    )
  }

  /** 执行一轮流式模型调用。 */
  public async executeStreamTurn(
    args: ExecuteStreamTurnArgs<TToolContext>
  ): Promise<StreamTurnResult> {
    // turn 门面把单轮流式模型调用交给 StreamTurn，由后者负责请求和 assistant/tool 历史拼接。
    return this.streamTurnHelper.executeStreamTurn({
      ...args,
      contextEpochGuard: args.contextEpochGuard ?? this.contextEpochGuard,
    })
  }

  /** 等待工具执行完成，并把结果追加到 history。 */
  public async appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<AgentTurnToolResult[]> {
    // 工具调用完成后必须追加 tool result 到 history，下一轮模型才能看到工具输出。
    return this.turnHistoryHelper.appendToolResultsToHistory(history, executor)
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
}

export { TurnRunner }
export { TurnRunner as AgentTurnHelper }
