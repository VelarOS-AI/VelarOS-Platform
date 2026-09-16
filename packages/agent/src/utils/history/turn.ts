import type { ModelMessage } from 'ai'

import { isEmpty, isFalse, toNullable } from '@velaros-ai/core'

import type { ToolResultModelContentPart } from '../../types/agent'
import type { AgentTurnToolExecutor, AgentTurnToolResult, AssistantContentPart, AssistantModelContentPart, AssistantRawContentPart } from '../../types/history.js'
import {
  compactToolInputForModel,
  extractSerializationHintsFromToolInput,
  serializeToolResultForModel,
} from '../tools/tool-result-serialization'

/** 把一份工具结果序列化成给模型看的字符串，序列化提示从该次调用的原始入参里推。 */
export function serializeTurnToolResultForModel(result: unknown, toolInput?: unknown): string {
  return serializeToolResultForModel(
    result,
    extractSerializationHintsFromToolInput(toolInput) || undefined
  )
}

/**
 * 从工具执行器收齐本轮全部结果，批量写成一条 `role:'tool'` 消息追加进历史。
 *
 * 失败的调用写成 `error-text`，带模型内容（图片/文本）的写成 `content`，其余写成纯文本；
 * 遇到终止错误在写回之后立即抛出，终止当前查询或流式循环，由上层决定是否清洗后重试。
 */
export async function appendToolResultsToHistory(
  history: ModelMessage[],
  executor: AgentTurnToolExecutor
): Promise<AgentTurnToolResult[]> {
  const toolResults = await executor.collectAll()
  history.push({
    role: 'tool',
    content: toolResults.map((result) => {
      const serializedResult = serializeTurnToolResultForModel(
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
            value: serializeTurnToolResultForModel(
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
        serializeTurnToolResultForModel(modelContentText, result.args) === serializedResult
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

/**
 * 把本轮助手产物写回历史：保留文本与工具调用，剔除推理内容（推理内容仅给界面展示，
 * 重放给模型会引发某些供应方的结构冲突），`replayable === false` 的文本（如自动注入的提示）也不进历史。
 * 清完什么都不剩时不写空消息。
 */
export function appendAssistantMessage(
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
      input: compactToolInputForModel(part.input, part.toolCallId),
    })
  })

  if (isEmpty(modelContent)) return

  history.push({
    role: 'assistant',
    content: modelContent,
  })
}

/** 把本轮助手产物摊成给界面回放的原始片段：文本、推理、工具调用都留着，工具入参不压缩。 */
export function toAssistantRawContent(
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
