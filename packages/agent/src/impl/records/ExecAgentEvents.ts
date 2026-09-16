import { toNullable, toOptional } from '@velaros-ai/core'

import type { AgentEvent } from '../../types/agent'
import type { ExecutionAgentEventLedgerStore } from '../../types/records.js'
import { describeAssistantRawContent, extractAssistantRawTextSummary, resolveRuntimeEventSeverity } from '../../utils/records/agent-event-payload'
import { compactToolResultForDisplay } from '../../utils/tools/tool-result-serialization'
import { AgentTuning } from '../../utils/tuning'

/**
 * Agent 事件落账：把 AgentRunner 流出来的事件翻成 `ExecutionRecord.events` 上的一条条时间线记录，
 * 供调试面板回放。事件挂在执行当前的任务（`currentTaskId`）下，不挂计划步骤。
 *
 * 自己不存东西，写入走构造时注入的 `ExecutionAgentEventLedgerStore`；每落一条（turn-context 除外）就触发一次调试快照重发。
 * 实现是 `ExecAgentEvents`（对外别名 `ExecutionAgentEventLedger`），由 `ExecutionService` 的 tap 调用。
 */
export interface ExecAgentEventsApi {
  /** 把一条 agent 事件落进这次执行的时间线：text-delta、reasoning-delta、生成文件、来源这四类高频事件直接丢弃（不然账本会爆），其余按类型翻成 turn-context-captured / assistant-output-captured / runtime-state-captured / tool-call-* 记录。执行不存在时由 store 抛错。 */
  appendAgentEvent(executionId: string, event: AgentEvent): void
}

class ExecAgentEvents implements ExecAgentEventsApi {
  /** 助手输出摘要最多留多少字符。 */
  private static readonly MaxAssistantOutputSummaryChars = AgentTuning.records.assistantOutputSummaryChars

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
        const textSummary = extractAssistantRawTextSummary(event.payload.content, ExecAgentEvents.MaxAssistantOutputSummaryChars)
        this.store.appendEvent(executionId, {
          kind: 'assistant-output-captured',
          severity: 'info',
          title: '助手输出已捕获',
          message: `第 ${event.payload.turn} 轮`,
          taskId: currentTaskId,
          planStepId: null,
          payload: {
            turn: event.payload.turn,
            contentShape: describeAssistantRawContent(event.payload.content),
            textSummary: toOptional(textSummary),
          },
        })
        this.emitExecutionDebug(executionId)
        return
      }
      case 'runtime':
        this.store.appendEvent(executionId, {
          kind: 'runtime-state-captured',
          severity: resolveRuntimeEventSeverity(event.payload.kind),
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
}

export { ExecAgentEvents }
export { ExecAgentEvents as ExecutionAgentEventLedger }
