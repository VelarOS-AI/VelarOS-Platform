import { toNullable } from '@velaros-ai/core'
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
} from '@velaros-ai/core/types'

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
   * 让文件树、git 摘要等外层 UI 仍能知道子线程改过文件。
   */
  public forWorkerExecution(options?: WorkerExecutionStreamOptions): ExecutionEventBus {
    return new ExecutionEventBus({
      agent: (event) => {
        if (event.type === 'text-delta' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'delta',
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
            timestamp: Date.now(),
            text: event.text,
          })
          return
        }

        if (event.type === 'reasoning-delta' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: Date.now(),
            chatEvent: {
              type: 'reasoning-delta',
              id: event.id,
              text: event.text,
            },
          })
          return
        }

        if (event.type === 'tool-start' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: Date.now(),
            chatEvent: {
              type: 'tool-start',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              categoryId: event.categoryId,
            },
          })
          return
        }

        if (event.type === 'tool-progress' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: event.timestamp ?? Date.now(),
            chatEvent: {
              type: 'tool-progress',
              toolCallId: event.toolCallId,
              chunk: event.chunk,
              timestamp: event.timestamp,
            },
          })
          return
        }

        if (event.type === 'tool-metadata' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: event.timestamp ?? Date.now(),
            chatEvent: {
              type: 'tool-metadata',
              toolCallId: event.toolCallId,
              title: event.title,
              metadata: event.metadata,
              timestamp: event.timestamp,
            },
          })
          return
        }

        if (event.type === 'tool-done' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: Date.now(),
            chatEvent: {
              type: 'tool-done',
              toolCallId: event.toolCallId,
              result: event.result,
              error: event.error,
              effects: event.effects,
              evidence: event.evidence,
              modelImage: event.modelImage,
            },
          })

          if (!event.effects?.contextInvalidated) return

          this.emitAgent({
            type: 'tool-done',
            toolCallId: `worker:${event.toolCallId}`,
            result: null,
            effects: event.effects,
          })
          return
        }

        if (event.type === 'tool-done' && event.effects?.contextInvalidated) {
          this.emitAgent({
            type: 'tool-done',
            toolCallId: `worker:${event.toolCallId}`,
            result: null,
            effects: event.effects,
          })
          return
        }

        if (event.type === 'notice' && options) {
          // 建议任务卡要渲染在主会话流里（用户在那里决策），不能只埋进
          // 子 agent 的 worker 线程详情——上浮为父级 notice；主会话侧按
          // suggestion id 去重，双份不会产生重复卡。
          if (event.kind === 'flagged-task') this.emitNotice(event)
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: Date.now(),
            chatEvent: {
              type: 'notice',
              kind: event.kind,
              payload: event.payload,
            },
          })
          return
        }

        if (event.type === 'runtime' && event.payload.kind === 'reconnecting' && options) {
          this.emitWorkerThread({
            kind: 'worker-thread',
            event: 'chat-event',
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
            timestamp: Date.now(),
            summary: `Reconnecting (${event.payload.attempt})`,
            chatEvent: {
              type: 'runtime-state',
              payload: event.payload,
            },
          })
          return
        }

        return
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
