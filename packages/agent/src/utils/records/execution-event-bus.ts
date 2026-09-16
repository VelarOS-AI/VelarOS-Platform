// ExecutionEventBus 用到的纯函数（不碰实例状态）。
import { toNullable } from '@velaros-ai/core'

import type { AgentEvent, StreamWorkerThreadPayload } from '../../types/agent'
import type { WorkerExecutionStreamOptions, WorkerThreadProjection } from '../../types/records.js'

/**
 * 线程身份信封：worker 线程事件里**与事件类型无关**的那部分。
 *
 * 收成一处的理由不是省行数，是**改一个字段不能只改对八分之一**：这些字段是前端认领同一条线程
 * （threadId / activationId）与定位其在计划树中位置（taskId / nodeId / dag）的依据，逐分支各抄
 * 一份时漏抄任一字段的症状是"某类事件的气泡挂错线程/挂不上"，且只在跑到那类事件时才出现。
 */
export function workerThreadEnvelope(
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
export function projectWorkerThreadEvent(event: AgentEvent): Nullable<WorkerThreadProjection> {
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
          modelImage: event.modelImage,
          modelContent: event.modelContent,
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
