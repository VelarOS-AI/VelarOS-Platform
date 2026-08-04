import { compactToolResultForDisplay } from '@velaros-ai/agent'
import type { AgentEvent, ExecutionEventSeverity, StreamStatePayload } from '@velaros-ai/agent/protocol'
import { isArray, isBlank, isObject, isString, toNullable, toOptional, truncate } from '@velaros-ai/core'

import type { ExecutionAgentEventLedgerStore } from './store-types'

const MaxAssistantOutputSummaryChars = 500

/**
 * Agent 事件账本。
 *
 * AgentRunner 在执行过程中发出的事件（turn-context/assistant-raw/runtime/tool-start/tool-done）
 * 会经过 ExecutionService 的 tap 转交给本类，落到 ExecutionRecord.events 时间线供调试面板回放。
 * 高频的 text-delta/reasoning-delta 不入账本，避免账本爆炸。
 */
class ExecAgentEvents {
  constructor(
    private readonly store: ExecutionAgentEventLedgerStore,
    private readonly emitExecutionDebug: (executionId: string) => void
  ) {}

  public appendAgentEvent(executionId: string, event: AgentEvent): void {
    const execution = this.store.require(executionId)
    const currentTaskId = execution.currentTaskId

    switch (event.type) {
      case 'text-delta':
      case 'reasoning-delta':
      case 'assistant-generated-file':
      case 'assistant-source':
        return
      case 'turn-context': {
        const { roleRuntimeModel, promptSegments, skippedPromptSegments, messages, ...payload } =
          event.payload
        this.store.appendEvent(executionId, {
          kind: 'turn-context-captured',
          severity: 'info',
          title: '运行上下文已捕获',
          message: `第 ${event.payload.turn} 轮 · ${event.payload.roleLabel}`,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            ...payload,
            provider: toNullable(roleRuntimeModel?.provider),
            model: toNullable(roleRuntimeModel?.model),
            contextWindow: toNullable(roleRuntimeModel?.contextWindow),
            promptSegmentCount: promptSegments.length,
            skippedPromptSegmentCount: skippedPromptSegments.length,
            messageCount: messages.length,
          },
        })
        return
      }
      case 'assistant-raw': {
        const textSummary = this.extractAssistantRawTextSummary(event.payload.content)
        this.store.appendEvent(executionId, {
          kind: 'assistant-output-captured',
          severity: 'info',
          title: '助手输出已捕获',
          message: `第 ${event.payload.turn} 轮`,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            turn: event.payload.turn,
            contentShape: this.describeAssistantRawContent(event.payload.content),
            textSummary: toOptional(textSummary),
          },
        })
        this.emitExecutionDebug(executionId)
        return
      }
      case 'runtime':
        this.store.appendEvent(executionId, {
          kind: 'runtime-state-captured',
          severity: this.resolveRuntimeEventSeverity(event.payload.kind),
          title: '运行状态已记录',
          message: event.payload.kind,
          taskId: currentTaskId,
          planStepId: null,
          payload: compactToolResultForDisplay(event.payload) as Record<string, unknown>,
        })
        this.emitExecutionDebug(executionId)
        return
      case 'tool-start':
        this.store.appendEvent(executionId, {
          kind: 'tool-call-started',
          severity: 'info',
          title: '工具调用已开始',
          message: event.toolName,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: compactToolResultForDisplay(event.args),
          },
        })
        this.emitExecutionDebug(executionId)
        return
      case 'tool-progress':
        this.store.appendEvent(executionId, {
          kind: 'tool-call-progress',
          severity: 'info',
          title: '工具调用进度',
          message: event.toolCallId,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            toolCallId: event.toolCallId,
            chunk: compactToolResultForDisplay(event.chunk),
            timestamp: toNullable(event.timestamp),
          },
        })
        this.emitExecutionDebug(executionId)
        return
      case 'tool-metadata':
        this.store.appendEvent(executionId, {
          kind: 'tool-call-metadata',
          severity: 'info',
          title: '工具调用状态',
          message: event.title ?? event.toolCallId,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            toolCallId: event.toolCallId,
            title: toNullable(event.title),
            metadata: toNullable(
              event.metadata ? compactToolResultForDisplay(event.metadata) : null
            ),
            timestamp: toNullable(event.timestamp),
          },
        })
        this.emitExecutionDebug(executionId)
        return
      case 'tool-done':
        this.store.appendEvent(executionId, {
          kind: 'tool-call-completed',
          severity: event.error ? 'error' : 'success',
          title: event.error ? '工具调用失败' : '工具调用完成',
          message: event.error ?? event.toolCallId,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            toolCallId: event.toolCallId,
            error: toNullable(event.error),
            result: compactToolResultForDisplay(event.result),
          },
        })
        this.emitExecutionDebug(executionId)
        return
    }
  }

  private resolveRuntimeEventSeverity(kind: StreamStatePayload['kind']): ExecutionEventSeverity {
    switch (kind) {
      case 'done':
        return 'success'
      case 'aborted':
        return 'warning'
      case 'error':
        return 'error'
      default:
        return 'info'
    }
  }

  private describeAssistantRawContent(content: unknown): Record<string, unknown> {
    if (!isArray(content))
      return {
        type: typeof content,
      }

    return {
      type: 'array',
      count: content.length,
      itemTypes: content
        .map((item) =>
          item && isObject(item) ? String((item as { type?: unknown }).type) : typeof item
        )
        .slice(0, 20),
    }
  }

  private extractAssistantRawTextSummary(content: unknown): Nullable<string> {
    if (isString(content)) return normalizeAssistantOutputSummary(content)
    if (!isArray(content)) return null

    const text = content
      .map((item) => {
        if (!item || !isObject(item)) return ''
        const record = item as { type?: unknown; text?: unknown }
        return record.type === 'text' && isString(record.text) ? record.text : ''
      })
      .filter((item) => item.trim())
      .join('\n')

    return normalizeAssistantOutputSummary(text)
  }
}

function normalizeAssistantOutputSummary(value: string): Nullable<string> {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (isBlank(normalized)) return null
  return truncate(normalized, MaxAssistantOutputSummaryChars)
}

export { ExecAgentEvents }
export { ExecAgentEvents as ExecutionAgentEventLedger }
