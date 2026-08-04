import type {
  AgentEvent,
  ChatRuntimeEvent,
  StreamAssistantGeneratedFilePayload,
  StreamAssistantRawPayload,
  StreamAssistantSourcePayload,
  StreamExecutionGraphPayload,
  StreamReasoningPayload,
  StreamStatePayload,
  StreamToolCallPayload,
  StreamToolMetadataPayload,
  StreamToolProgressPayload,
  StreamToolResultPayload,
  StreamTurnContextPayload,
  StreamWorkerThreadPayload,
} from '@velaros-ai/agent/protocol'
import { toNullable } from '@velaros-ai/core'

interface ExecutionEventBusHandlers {
  /** Agent 文本、工具、runtime、turn context 等流式事件。 */
  agent?: (event: AgentEvent) => void
  /** 面向 UI 的阶段/等待/完成等状态事件。 */
  state?: (payload: StreamStatePayload) => void
  /** 执行图和调试面板需要的结构化快照。 */
  debug?: (payload: StreamExecutionGraphPayload) => void
}

interface WorkerExecutionStreamOptions {
  threadId: string
  activationId?: LooseOptional<string>
  taskId?: LooseOptional<string>
  nodeId?: LooseOptional<string>
  title: string
  agentName?: LooseOptional<string>
  roleId?: LooseOptional<StreamWorkerThreadPayload['roleId']>
  phase?: LooseOptional<StreamWorkerThreadPayload['phase']>
  capabilityTarget?: LooseOptional<StreamWorkerThreadPayload['capabilityTarget']>
  dag?: LooseOptional<StreamWorkerThreadPayload['dag']>
}

/** worker 线程事件里随事件类型变化的那几个字段；其余字段全部由线程身份信封给定。 */
type WorkerThreadProjection = Pick<StreamWorkerThreadPayload, 'event'> &
  Partial<Pick<StreamWorkerThreadPayload, 'timestamp' | 'text' | 'summary' | 'chatEvent'>>

/**
 * 线程身份信封：worker 线程事件里**与事件类型无关**的那部分。
 *
 * 收成一处的理由不是省行数，是**改一个字段不能只改对八分之一**：这些字段是前端认领同一条线程
 * （threadId / activationId）与定位其在计划树中位置（taskId / nodeId / dag）的依据，逐分支各抄
 * 一份时漏抄任一字段的症状是"某类事件的气泡挂错线程/挂不上"，且只在跑到那类事件时才出现。
 */
function workerThreadEnvelope(
  options: WorkerExecutionStreamOptions
): Omit<StreamWorkerThreadPayload, 'event' | 'timestamp'> {
  return {
    kind: 'worker-thread',
    threadId: options.threadId,
    activationId: toNullable(options.activationId),
    taskId: toNullable(options.taskId),
    nodeId: toNullable(options.nodeId),
    title: options.title,
    agentName: toNullable(options.agentName),
    roleId: toNullable(options.roleId),
    phase: toNullable(options.phase),
    status: 'running',
    capabilityTarget: toNullable(options.capabilityTarget),
    dag: toNullable(options.dag),
  }
}

/**
 * agent 事件 → worker 线程投影；返回 null 表示这类事件不进线程详情（静默丢弃）。
 *
 * 白名单而非黑名单：worker 的输出默认**不**冒到主聊天流（主会话只听协调者/汇总者），所以新增
 * 事件类型的缺省是"不透出"，要透出必须在这里显式登记。
 * `tool-progress` / `tool-metadata` 用事件自带 timestamp（它们是有序增量，用接收时刻会让
 * 乱序到达的分片在 UI 上排错序），其余用接收时刻。
 */
function projectWorkerThreadEvent(event: AgentEvent): Nullable<WorkerThreadProjection> {
  switch (event.type) {
    case 'text-delta':
      return { event: 'delta', text: event.text }
    case 'reasoning-delta':
      return {
        event: 'chat-event',
        chatEvent: { type: 'reasoning-delta', id: event.id, text: event.text },
      }
    case 'tool-start':
      return {
        event: 'chat-event',
        chatEvent: {
          type: 'tool-start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          categoryId: event.categoryId,
        },
      }
    case 'tool-progress':
      return {
        event: 'chat-event',
        timestamp: event.timestamp,
        chatEvent: {
          type: 'tool-progress',
          toolCallId: event.toolCallId,
          chunk: event.chunk,
          timestamp: event.timestamp,
        },
      }
    case 'tool-metadata':
      return {
        event: 'chat-event',
        timestamp: event.timestamp,
        chatEvent: {
          type: 'tool-metadata',
          toolCallId: event.toolCallId,
          title: event.title,
          metadata: event.metadata,
          timestamp: event.timestamp,
        },
      }
    case 'tool-done':
      return {
        event: 'chat-event',
        chatEvent: {
          type: 'tool-done',
          toolCallId: event.toolCallId,
          result: event.result,
          error: event.error,
          effects: event.effects,
          evidence: event.evidence,
          modelImage: event.modelImage,
        },
      }
    case 'notice':
      return {
        event: 'chat-event',
        chatEvent: { type: 'notice', kind: event.kind, payload: event.payload },
      }
    case 'runtime':
      if (event.payload.kind !== 'reconnecting') return null
      return {
        event: 'chat-event',
        summary: `Reconnecting (${event.payload.attempt})`,
        chatEvent: { type: 'runtime-state', payload: event.payload },
      }
    default:
      return null
  }
}

/**
 * 执行事件总线。
 *
 * 执行服务、智能体运行器和工具执行器不直接依赖宿主视图；
 * 它们只向这个总线发送事件。聊天执行协调器再把事件转给渲染进程。
 *
 * 事件分三类通道：
 *  - `agent`：模型文本、工具调用、运行时和通知等流式片段，对应渲染进程的流协议。
 *  - `state`：执行阶段、等待输入、完成态等状态机切换，用于界面控制态。
 *  - `debug`：执行图调试快照，仅在调试面板订阅时使用。
 *
 * 总线本身是同步派发——handler 抛错会冒泡到调用方；调用方（如 streamHelper）必须
 * 自己捕获异常，否则会中断一次 agent loop。使用 withAgentTap 可以插入旁路监听（账本写入）
 * 而不影响最终 forward 行为。
 */
class ExecutionEventBus {
  constructor(private readonly handlers: ExecutionEventBusHandlers = {}) {}

  /** 测试或后台执行不需要事件输出时使用的空总线。 */
  public static noop(): ExecutionEventBus {
    return new ExecutionEventBus()
  }

  /** 在 agent 事件转发前插入旁路监听，ExecutionService 用它写入事件账本。 */
  public withAgentTap(tap: (event: AgentEvent) => void): ExecutionEventBus {
    return new ExecutionEventBus({
      agent: (event) => {
        tap(event)
        this.emitAgent(event)
      },
      state: (payload) => this.emitState(payload),
      debug: (payload) => this.emitDebug(payload),
    })
  }

  /**
   * 给团队 worker 内部模型循环使用的静默总线。
   *
   * worker 的工具调用、turn context 和原始输出不直接渲染到主聊天流；
   * 主会话只看协调者/汇总者的声音。这里仅透出宿主资源刷新副作用，
   * 让文件树、版本状态摘要等外层 UI 仍能知道子线程改过资源。
   *
   * **两条上浮通道的顺序是契约**（父总线上的先后就是 UI 上的先后）：
   *  1. 先发 worker 线程事件（线程详情里的时间线）；
   *  2. 再发 contextInvalidated 的 tool-done 上浮（父侧据此作废在途上下文）。
   * 反过来会让父级先收到"上下文已失效"、后收到造成失效的那条工具事件。
   *
   * `options` 缺席 = 不接线程详情：此时**只**保留 contextInvalidated 上浮，其余一律静默丢弃。
   * 这条正确性通道与"要不要渲染线程"无关，不能一起关掉。
   */
  public forWorkerExecution(options?: WorkerExecutionStreamOptions): ExecutionEventBus {
    return new ExecutionEventBus({
      agent: (event) => {
        if (options) {
          // 建议任务卡要渲染在主会话流里（用户在那里决策），不能只埋进
          // 子 agent 的 worker 线程详情——上浮为父级 notice；主会话侧按
          // suggestion id 去重，双份不会产生重复卡。
          if (event.type === 'notice' && event.kind === 'flagged-task') this.emitNotice(event)

          const projection = projectWorkerThreadEvent(event)
          if (projection) {
            this.emitWorkerThread({
              ...workerThreadEnvelope(options),
              ...projection,
              timestamp: projection.timestamp ?? Date.now(),
            })
          }
        }

        if (event.type === 'tool-done' && event.effects?.contextInvalidated) {
          this.emitAgent({
            type: 'tool-done',
            toolCallId: `worker:${event.toolCallId}`,
            result: null,
            effects: event.effects,
          })
        }
      },
    })
  }

  /** 发送原始 agent 事件。 */
  public emitAgent(event: AgentEvent): void {
    this.handlers.agent?.(event)
  }

  /** 发送 runtime 级事件，如 done/error/aborted。 */
  public emitRuntime(payload: ChatRuntimeEvent): void {
    this.emitAgent({
      type: 'runtime',
      payload,
    })
  }

  /** 发送助手文本增量。 */
  public emitTextDelta(text: string): void {
    // TODO[主链路-51]: 模型文本增量从 turn helper 进入事件总线，再由 ChatExecutionCoordinator 的 streamHelper 发送到 renderer。
    this.emitAgent({
      type: 'text-delta',
      text,
    })
  }

  /** 发送 reasoning 增量，供支持的 UI 展示思考流。 */
  public emitReasoningDelta(payload: StreamReasoningPayload): void {
    this.emitAgent({
      type: 'reasoning-delta',
      id: payload.id,
      text: payload.text,
    })
  }

  /** 发送模型生成的文件；renderer 统一负责展示与持久化。 */
  public emitGeneratedFile(payload: StreamAssistantGeneratedFilePayload): void {
    this.emitAgent({ type: 'assistant-generated-file', payload })
  }

  /** 发送模型实际使用的 URL 来源。 */
  public emitSource(payload: StreamAssistantSourcePayload): void {
    this.emitAgent({ type: 'assistant-source', payload })
  }

  /** 发送当前轮角色/上下文信息，ExecutionService 会据此更新任务角色。 */
  public emitTurnContext(payload: StreamTurnContextPayload): void {
    this.emitAgent({
      type: 'turn-context',
      payload,
    })
  }

  /** 发送模型原始片段，主要用于调试和回放。 */
  public emitAssistantRaw(payload: StreamAssistantRawPayload): void {
    this.emitAgent({
      type: 'assistant-raw',
      payload,
    })
  }

  /** 发送团队 worker 线程生命周期事件，供主聊天页显示并行执行过程。 */
  public emitWorkerThread(payload: StreamWorkerThreadPayload): void {
    this.emitAgent({
      type: 'worker-thread',
      payload,
    })
  }

  /** 工具开始执行时发给 UI，展示 tool call block。 */
  public emitToolStart(payload: StreamToolCallPayload): void {
    // TODO[主链路-52]: tool-call 开始事件也走同一条 agent event 通道，UI 用它渲染工具卡片。
    this.emitAgent({
      type: 'tool-start',
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
      categoryId: payload.categoryId,
    })
  }

  /** 工具执行期间的增量进度。 */
  public emitToolProgress(payload: StreamToolProgressPayload): void {
    this.emitAgent({
      type: 'tool-progress',
      toolCallId: payload.toolCallId,
      chunk: payload.chunk,
      timestamp: payload.timestamp,
    })
  }

  /** 工具执行期间的结构化展示元数据。 */
  public emitToolMetadata(payload: StreamToolMetadataPayload): void {
    this.emitAgent({
      type: 'tool-metadata',
      toolCallId: payload.toolCallId,
      title: payload.title,
      metadata: payload.metadata,
      timestamp: payload.timestamp,
    })
  }

  /** 工具执行完成或失败时发给 UI。 */
  public emitToolDone(payload: StreamToolResultPayload): void {
    // TODO[主链路-53]: 工具结果先发给 UI，再由 AgentTurnHistoryHelper 写入 history 供下一轮模型读取。
    this.emitAgent({
      type: 'tool-done',
      toolCallId: payload.toolCallId,
      result: payload.result,
      error: payload.error,
      effects: payload.effects,
      evidence: payload.evidence,
      modelImage: payload.modelImage,
    })
  }

  /**
   * 向 UI 推送独立 notice 事件（capability-auto-approval / user-action-card /
   * capability notices），不再嵌入工具结果。
   */
  public emitNotice(event: Extract<AgentEvent, { type: 'notice' }>): void {
    this.emitAgent(event)
  }

  /** 发送执行阶段/等待输入等状态。 */
  public emitState(payload: StreamStatePayload): void {
    this.handlers.state?.(payload)
  }

  /** 发送执行图调试快照。 */
  public emitDebug(payload: StreamExecutionGraphPayload): void {
    this.handlers.debug?.(payload)
  }
}

export { ExecutionEventBus }
export type { ExecutionEventBusHandlers, WorkerExecutionStreamOptions }
