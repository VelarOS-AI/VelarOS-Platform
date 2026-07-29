import { isArray, isPlainObject, isPresent,isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

export interface ProviderToolInputDraft {
  id: string
  toolName: string
  inputText: string
  inputEnded: boolean
}

export type ProviderFinalToolInputResolution =
  | { ok: true; input: Record<string, unknown>; reparsedString: boolean }
  | {
      ok: false
      reason: 'final_tool_input_json_parse_failed' | 'final_tool_input_not_object'
      receivedType: string
      inputChars: number
    }

/**
 * AI SDK 的 final `tool-call` 按契约应给出 object，但部分兼容网关会在输出达到上限时
 * 把尚未闭合的 JSON 原文作为 string 交出来。这里允许完整、可解析的双重序列化 JSON
 * 自愈；不完整或非 object 的值必须留在“未被接受的工具调用”路径，绝不能下发执行器。
 */
export function resolveProviderFinalToolInput(
  value: unknown
): ProviderFinalToolInputResolution {
  if (isPlainObject(value)) return {
      ok: true,
      input: value as Record<string, unknown>,
      reparsedString: false,
    }

  if (isString(value)) {
    const trimmed = value.trim()
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isPlainObject(parsed)) return {
          ok: true,
          input: parsed as Record<string, unknown>,
          reparsedString: true,
        }
    } catch {
      return {
        ok: false,
        reason: 'final_tool_input_json_parse_failed',
        receivedType: 'string',
        inputChars: value.length,
      }
    }
  }

  return {
    ok: false,
    reason: 'final_tool_input_not_object',
    receivedType: value === null ? 'null' : isArray(value) ? 'array' : typeof value,
    inputChars: isString(value) ? value.length : 0,
  }
}

export function buildToolInputReadyMetadata(inputText: string): Record<string, unknown> {
  return {
    phase: 'tool-input-ready',
    inputChars: inputText.length,
    streamedInput: true,
  }
}

export function summarizeProviderToolInputDraft(
  draft: ProviderToolInputDraft
): Record<string, unknown> {
  return {
    id: draft.id,
    toolName: draft.toolName,
    inputChars: draft.inputText.length,
    inputTrimmedChars: draft.inputText.trim().length,
    inputEnded: draft.inputEnded,
  }
}

export function buildToolInputProtocolError(input: {
  reason: string
  toolCallId: string
  model: string
  turn?: LooseOptional<number>
  toolName?: LooseOptional<string>
  finalToolName?: LooseOptional<string>
}): AppError {
  const context: Record<string, unknown> = {
    source: 'stream-tool-input',
    reason: input.reason,
    model: input.model,
    toolCallId: input.toolCallId,
  }
  if (isPresent(input.turn)) context.turn = input.turn
  if (input.toolName) context.toolName = input.toolName
  if (input.finalToolName) context.finalToolName = input.finalToolName

  return new AppError(
    'MODEL_STREAM_INTERRUPTED',
    '模型流工具参数片段顺序异常，已中止本轮请求。',
    undefined,
    context
  )
}

export function parseEndedProviderToolInputDraft(
  draft: ProviderToolInputDraft,
  input: {
    model: string
    turn?: LooseOptional<number>
  }
): Record<string, unknown> {
  return parseProviderToolInputDraft(draft, input, {
    allowEmptyInput: true,
    allowIncompleteJson: false,
  }) ?? {}
}

export function parseRecoverableProviderToolInputDraft(
  draft: ProviderToolInputDraft,
  input: {
    model: string
    turn?: LooseOptional<number>
  }
): Nullable<Record<string, unknown>> {
  return parseProviderToolInputDraft(draft, input, {
    allowEmptyInput: draft.inputEnded,
    allowIncompleteJson: !draft.inputEnded,
  })
}

function parseProviderToolInputDraft(
  draft: ProviderToolInputDraft,
  input: {
    model: string
    turn?: LooseOptional<number>
  },
  options: {
    allowEmptyInput: boolean
    allowIncompleteJson: boolean
  }
): Nullable<Record<string, unknown>> {
  const trimmed = draft.inputText.trim()
  if (!trimmed) return options.allowEmptyInput ? {} : null

  let parsed: unknown

  try {
    parsed = JSON.parse(trimmed)
  } catch {
    if (options.allowIncompleteJson) return null

    throw buildToolInputProtocolError({
      reason: 'tool_input_json_parse_failed',
      toolCallId: draft.id,
      toolName: draft.toolName,
      model: input.model,
      turn: input.turn,
    })
  }

  if (!isPlainObject(parsed)) {
    throw buildToolInputProtocolError({
      reason: 'tool_input_json_not_object',
      toolCallId: draft.id,
      toolName: draft.toolName,
      model: input.model,
      turn: input.turn,
    })
  }

  return parsed
}

export function takeProviderToolInputDraftForFinalCall(
  drafts: Map<string, ProviderToolInputDraft>,
  input: {
    toolCallId: string
    toolName: string
    model: string
    turn?: LooseOptional<number>
  }
): Nullable<ProviderToolInputDraft> {
  const draft = drafts.get(input.toolCallId)
  if (!draft) return null

  if (draft.toolName !== input.toolName) {
    throw buildToolInputProtocolError({
      reason: 'tool_input_name_mismatch',
      toolCallId: input.toolCallId,
      toolName: draft.toolName,
      finalToolName: input.toolName,
      model: input.model,
      turn: input.turn,
    })
  }

  drafts.delete(input.toolCallId)
  return draft
}

type ProviderToolInputPartLike =
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }

export function applyProviderToolInputStreamPart(
  part: { type: string },
  drafts: Map<string, ProviderToolInputDraft>,
  options: {
    model: string
    turn?: LooseOptional<number>
    markVisibleOutput: () => void
    resolveToolName: (toolName: string) => string
  }
): boolean {
  switch (part.type) {
    case 'tool-input-start': {
      const inputPart = part as Extract<
        ProviderToolInputPartLike,
        { type: 'tool-input-start' }
      >
      if (drafts.has(inputPart.id)) {
        throw buildToolInputProtocolError({
          reason: 'duplicate_tool_input_start',
          toolCallId: inputPart.id,
          toolName: inputPart.toolName,
          model: options.model,
          turn: options.turn,
        })
      }
      options.markVisibleOutput()
      drafts.set(inputPart.id, {
        id: inputPart.id,
        toolName: options.resolveToolName(inputPart.toolName),
        inputText: '',
        inputEnded: false,
      })
      return true
    }
    case 'tool-input-delta': {
      const inputPart = part as Extract<
        ProviderToolInputPartLike,
        { type: 'tool-input-delta' }
      >
      options.markVisibleOutput()
      const draft = drafts.get(inputPart.id)
      if (!draft) {
        throw buildToolInputProtocolError({
          reason: 'tool_input_delta_before_start',
          toolCallId: inputPart.id,
          model: options.model,
          turn: options.turn,
        })
      }
      if (draft.inputEnded) {
        throw buildToolInputProtocolError({
          reason: 'tool_input_delta_after_end',
          toolCallId: inputPart.id,
          toolName: draft.toolName,
          model: options.model,
          turn: options.turn,
        })
      }
      draft.inputText += inputPart.delta
      return true
    }
    case 'tool-input-end': {
      const inputPart = part as Extract<
        ProviderToolInputPartLike,
        { type: 'tool-input-end' }
      >
      const draft = drafts.get(inputPart.id)
      if (!draft) {
        throw buildToolInputProtocolError({
          reason: 'tool_input_end_before_start',
          toolCallId: inputPart.id,
          model: options.model,
          turn: options.turn,
        })
      }
      if (draft.inputEnded) {
        throw buildToolInputProtocolError({
          reason: 'duplicate_tool_input_end',
          toolCallId: inputPart.id,
          toolName: draft.toolName,
          model: options.model,
          turn: options.turn,
        })
      }
      draft.inputEnded = true
      options.markVisibleOutput()
      return true
    }
    default:
      return false
  }
}
