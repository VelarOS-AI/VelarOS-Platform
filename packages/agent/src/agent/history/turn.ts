import type { ModelMessage } from 'ai'

import {
  compactToolInputForModel,
  extractSerializationHintsFromToolInput,
  serializeToolResultForModel,
} from '@velaros-ai/agent'
import type { ToolResultModelContentPart } from '@velaros-ai/agent/protocol'
import { isEmpty, isFalse, toNullable } from '@velaros-ai/core'

interface AgentTurnToolResult {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: unknown
  modelResult?: unknown
  error?: LooseOptional<string>
  modelImage?: {
    data: string
    mediaType: string
  }
  modelContent?: ToolResultModelContentPart[]
}

interface AgentTurnToolExecutor {
  collectAll(): Promise<AgentTurnToolResult[]>
  getTerminalError(): unknown
}

export type AssistantContentPart =
  | { type: 'text'; text: string; replayable?: boolean }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }

type AssistantModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }

type AssistantRawContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }

class ToolResults {
  public serializeForModel(result: unknown, toolInput?: unknown): string {
    return serializeToolResultForModel(
      result,
      extractSerializationHintsFromToolInput(toolInput) || undefined
    )
  }
}

const agentToolResultHelper = new ToolResults()

/**
 * 轮次历史：把单轮产物落到模型消息历史。
 *
 * 分两类写回：
 * - 助手消息：保留文本与工具调用，剔除推理内容（推理内容仅给界面展示，
 *   重放给模型会引发某些供应方的结构冲突），且 `replayable === false` 的文本
 *   （如自动注入的提示）不会进入历史。
 * - 工具消息：从工具执行器收齐所有结果后批量写入；遇到终止错误立即抛出，
 *   终止当前查询或流式循环，由上层决定是否清洗后重试。
 *
 * 注意：当前轮工具执行使用原始输入；写入可回放历史时只压缩超大字段值，
 * 不能破坏模型传入对象的结构。
 */
class TurnHistory {
  public async appendToolResultsToHistory(
    history: ModelMessage[],
    executor: AgentTurnToolExecutor
  ): Promise<AgentTurnToolResult[]> {
    const toolResults = await executor.collectAll()
    history.push({
      role: 'tool',
      content: toolResults.map((result) => {
        const serializedResult = agentToolResultHelper.serializeForModel(
          toNullable(result.modelResult ?? result.result),
          result.args
        )
        if (result.error)
          return {
            type: 'tool-result' as const,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            output: {
              type: 'error-text' as const,
              value: agentToolResultHelper.serializeForModel(
                toNullable(result.modelResult ?? result.result) ?? {
                  error: 'tool_execution_failed',
                  reason: result.error,
                  toolName: result.toolName,
                },
                result.args
              ),
            },
          }

        const modelContent = [...(result.modelContent ?? [])]
        if (result.modelImage && !modelContent.some((part) =>
          part.type === 'image-data' &&
          part.data === result.modelImage?.data &&
          part.mediaType === result.modelImage.mediaType
        )) {
          modelContent.push({
            type: 'image-data',
            data: result.modelImage.data,
            mediaType: result.modelImage.mediaType,
          })
        }

        const modelContentText = modelContent
          .filter((part): part is Extract<ToolResultModelContentPart, { type: 'text' }> =>
            part.type === 'text'
          )
          .map((part) => part.text)
          .join('\n')
          .trim()
        const modelContentRepresentsResult = !!modelContentText &&
          agentToolResultHelper.serializeForModel(modelContentText, result.args) === serializedResult
        const providerContent = modelContentRepresentsResult
          ? modelContent
          : [{ type: 'text' as const, text: serializedResult }, ...modelContent]

        return {
          type: 'tool-result' as const,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: !isEmpty(modelContent)
            ? { type: 'content' as const, value: providerContent }
            : { type: 'text' as const, value: serializedResult },
        }
      }),
    })

    const terminalError = executor.getTerminalError()
    if (terminalError) {
      throw terminalError
    }
    return toolResults
  }

  public appendAssistantMessage(
    history: ModelMessage[],
    assistantContent: AssistantContentPart[]
  ): void {
    const modelContent: AssistantModelContentPart[] = []

    assistantContent.forEach((part) => {
      if (part.type === 'text') {
        if (isFalse(part.replayable)) return
        modelContent.push({ type: 'text', text: part.text })
        return
      }

      if (part.type === 'reasoning') return

      modelContent.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: compactToolInputForModel(part.input),
      })
    })

    if (isEmpty(modelContent)) return

    history.push({
      role: 'assistant',
      content: modelContent,
    })
  }

  public toAssistantRawContent(
    assistantContent: AssistantContentPart[]
  ): AssistantRawContentPart[] {
    return assistantContent.map((part) => {
      switch (part.type) {
        case 'text': {
          return { type: 'text', text: part.text }
        }
        case 'reasoning': {
          return { type: 'reasoning', text: part.text }
        }
        default: {
          return {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          }
        }
      }
    })
  }
}

export { agentToolResultHelper, ToolResults, TurnHistory }
export type { AgentTurnToolExecutor, AgentTurnToolResult }
export { ToolResults as AgentToolResultHelper, TurnHistory as AgentTurnHistoryHelper }
