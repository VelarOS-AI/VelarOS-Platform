/**
 * Stream 可观测性取样：从 AgentEvent / IPC 事件里挑出值得落日志的那几种，翻成统一的日志条目。
 * 纯函数、不持状态，`ChatStreamProtocol` 在桥接每个事件时顺路调用。
 */

import { toOptional } from '@velaros-ai/core/utils/nullish'

import type { AgentEvent } from '../../types/agent'
import type { ChatStreamEvent } from '../../types/agent.js'
import type { StreamObservabilityEntry } from '../../types/chat.js'

/**
 * 从一条 AgentEvent 里取日志条目。只有「执行被中止」值得记一条 info（带上 code、message、
 * executionId 便于对上是哪次执行），其余事件量太大、不落日志，一律返回空数组。
 */
export function readAgentEventObservability(event: AgentEvent): StreamObservabilityEntry[] {
  if (event.type !== 'runtime' || event.payload.kind !== 'aborted') return []

  return [
    {
      level: 'info',
      message: 'stream aborted',
      context: {
        code: event.payload.code,
        message: event.payload.message,
        executionId: event.payload.executionId,
      },
    },
  ]
}

/**
 * 从一条已经翻成 IPC 形态的流事件里取日志条目。只有 `error` 事件记一条 error 级日志，
 * 带上 code、message 和（有才带的）错误上下文；其余事件返回空数组。
 */
export function readStreamEventObservability(event: ChatStreamEvent): StreamObservabilityEntry[] {
  if (event.type !== 'error') return []

  return [
    {
      level: 'error',
      message: 'stream failed',
      context: {
        code: event.payload.code,
        message: event.payload.message,
        errorContext: toOptional(event.payload.context),
      },
    },
  ]
}
