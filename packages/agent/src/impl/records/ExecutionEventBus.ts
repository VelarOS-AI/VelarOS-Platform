
import type { AgentEvent, ChatRuntimeEvent, StreamAssistantGeneratedFilePayload, StreamAssistantRawPayload, StreamAssistantSourcePayload, StreamExecutionGraphPayload, StreamReasoningPayload, StreamStatePayload, StreamToolCallPayload, StreamToolMetadataPayload, StreamToolProgressPayload, StreamToolResultPayload, StreamTurnContextPayload, StreamWorkerThreadPayload } from '../../types/agent'
import type { ExecutionEventBusHandlers, WorkerExecutionStreamOptions } from '../../types/records.js'
import { projectWorkerThreadEvent, workerThreadEnvelope } from '../../utils/records/execution-event-bus'

/**
 * 执行事件的出口：执行服务、AgentRunner、工具执行器都不认宿主视图，只往这条总线上发事件，
 * 再由聊天执行协调器转给渲染进程。事件分 agent（流式片段）、state（界面控制态）、debug（执行图快照）三条通道。
 *
 * 派发是同步的，handler 抛错会冒泡到发事件的那一方，调用方必须自己兜住，否则会打断一整轮 agent loop。
 * 总线本身不存事件，只有构造时传入的三个 handler；`withAgentTap` / `forWorkerExecution` 都是返回新实例，原实例不变。
 */
export interface ExecutionEventBusApi {
  /** 派生一条新总线：agent 事件先给 `tap` 看一眼再原样转发，state / debug 直通。`ExecutionService` 用它在不改变转发行为的前提下把事件写进账本。 */
  withAgentTap(tap: (event: AgentEvent) => void): ExecutionEventBusApi
  /** 派生给团队 worker 内部模型循环用的静默总线：worker 的输出默认不冒到主聊天流。给了 `options` 才把白名单内的事件投影成 worker 线程事件；无论给不给，工具副作用里的 contextInvalidated 都会上浮成父级 tool-done（这是正确性通道，不能随线程详情一起关）。两条上浮的先后顺序是契约：先线程事件，后 contextInvalidated。 */
  forWorkerExecution(options?: WorkerExecutionStreamOptions): ExecutionEventBusApi
  /** 原样发一条 agent 事件；下面各 `emitXxx` 最后都落到这里。没接 agent handler 时静默丢弃。 */
  emitAgent(event: AgentEvent): void
  /** 发 runtime 级事件（done / error / aborted / reconnecting 等），宿主据此切换整轮的运行状态。 */
  emitRuntime(payload: ChatRuntimeEvent): void
  /** 发一段助手文本增量；高频事件，不入账本，只往渲染端流。 */
  emitTextDelta(text: string): void
  /** 发一段思考（reasoning）增量，供支持展示思考流的界面用；同样不入账本。 */
  emitReasoningDelta(payload: StreamReasoningPayload): void
  /** 发一份模型生成的文件，展示与持久化都由 renderer 负责。 */
  emitGeneratedFile(payload: StreamAssistantGeneratedFilePayload): void
  /** 发一条模型实际引用到的 URL 来源，供界面标注出处。 */
  emitSource(payload: StreamAssistantSourcePayload): void
  /** 发这一轮的角色与上下文信息；`ExecutionService` 据此更新任务的角色归属，账本也会留一条。 */
  emitTurnContext(payload: StreamTurnContextPayload): void
  /** 发模型这一轮的原始输出片段，主要给调试面板和回放用。 */
  emitAssistantRaw(payload: StreamAssistantRawPayload): void
  /** 发一条 worker 线程生命周期事件，主聊天页据此渲染并行执行的线程详情。 */
  emitWorkerThread(payload: StreamWorkerThreadPayload): void
  /** 工具开始执行时发，界面据此建出这次调用的工具卡。 */
  emitToolStart(payload: StreamToolCallPayload): void
  /** 工具执行期间的增量输出；`payload.timestamp` 是事件自带的顺序依据，乱序到达时按它排。 */
  emitToolProgress(payload: StreamToolProgressPayload): void
  /** 工具执行期间的结构化展示信息（标题、元数据），用来把工具卡从「运行中」刷成有内容的样子。 */
  emitToolMetadata(payload: StreamToolMetadataPayload): void
  /** 工具执行完成或失败时发；`payload.error` 有值即失败。宿主收到后，历史那边才会把结果写进下一轮的消息。 */
  emitToolDone(payload: StreamToolResultPayload): void
  /** 发一条独立的 notice 事件（能力自动批准、用户动作卡等），不再塞进工具结果里。 */
  emitNotice(event: Extract<AgentEvent, { type: 'notice' }>): void
  /** 发执行阶段、等待输入、收尾等状态；走 state 通道，界面用来切控制态。没接 state handler 时静默丢弃。 */
  emitState(payload: StreamStatePayload): void
  /** 发一份执行图调试快照；走 debug 通道，只有调试面板订阅时才有人接。 */
  emitDebug(payload: StreamExecutionGraphPayload): void
}

class ExecutionEventBus implements ExecutionEventBusApi {
  constructor(private readonly handlers: ExecutionEventBusHandlers = {}) {}

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
    // 模型文本增量从 turn helper 进入事件总线，再由宿主流桥接器发送到渲染端。
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
    // tool-call 开始事件走同一条 agent event 通道，供宿主渲染工具状态。
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
    // 工具结果先通知宿主，再由 agentTurnHistory 写入 history 供下一轮模型读取。
    this.emitAgent({
      type: 'tool-done',
      toolCallId: payload.toolCallId,
      result: payload.result,
      error: payload.error,
      effects: payload.effects,
      modelImage: payload.modelImage,
      modelContent: payload.modelContent,
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
export type { ExecutionEventBusHandlers }

/** 建一条执行事件总线；不给处理器就是一条不往外发的空总线。 */
export function createExecutionEventBus(handlers: ExecutionEventBusHandlers = {}): ExecutionEventBusApi {
  return new ExecutionEventBus(handlers)
}

/** 建一条什么都不往外发的空总线：测试与后台执行不需要事件输出时用它。 */
export function createNoopExecutionEventBus(): ExecutionEventBusApi {
  return new ExecutionEventBus()
}
