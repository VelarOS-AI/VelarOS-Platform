import {
  isArray,
  isNonBlankString,
  isNull,
  isPlainObject,
  isPresent,
  isString,
  toOptional,
} from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";

export interface ProviderToolInputDraft {
  id: string;
  toolName: string;
  providerToolName: string;
  requestAdvertised: boolean;
  inputText: string;
  inputEnded: boolean;
}

export interface ProviderToolNameResolution {
  toolName: string;
  providerToolName: string;
  requestAdvertised: boolean;
}

export interface ProviderFinalToolCallIdentity {
  toolNameResolution: ProviderToolNameResolution;
  streamedInput: Nullable<ProviderToolInputDraft>;
}

export type ProviderFinalToolInputResolution =
  | { ok: true; input: Record<string, unknown>; reparsedString: boolean }
  | {
      ok: false;
      reason:
        "final_tool_input_json_parse_failed" | "final_tool_input_not_object";
      receivedType: string;
      inputChars: number;
    };

export type ProviderExecutableToolInputResolution =
  | {
      ok: true;
      input: Record<string, unknown>;
      source: "final" | "ended-stream-draft";
    }
  | Extract<ProviderFinalToolInputResolution, { ok: false }>;

export interface ProviderJsonTextDiagnostic {
  inputChars: number;
  trimmedChars: number;
  startsWithObject: boolean;
  endsWithObject: boolean;
  objectDepth: number;
  arrayDepth: number;
  terminatedInString: boolean;
  danglingEscape: boolean;
  mismatchedDelimiter: boolean;
  rawControlCharactersInString: number;
  parseStatus: "object" | "json-non-object" | "invalid-json";
}

export interface RejectedProviderToolInputDiagnostic {
  final?: ProviderJsonTextDiagnostic;
  streamDraft?: ProviderJsonTextDiagnostic & {
    inputEnded: boolean;
    identicalToFinal: boolean;
  };
}

/**
 * 只记录 JSON 的结构事实，不记录正文、路径或任何可逆摘要。
 * 这能区分未闭合字符串、括号截断、原始换行和 provider final/delta 分叉，
 * 同时保证长文本工具参数不会泄漏进日志或错误上下文。
 */
export function diagnoseProviderJsonText(
  inputText: string,
): ProviderJsonTextDiagnostic {
  const trimmed = inputText.trim();
  const delimiters: string[] = [];
  let inString = false;
  let escaped = false;
  let mismatchedDelimiter = false;
  let rawControlCharactersInString = 0;

  for (const character of trimmed) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = false;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) rawControlCharactersInString += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      delimiters.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (delimiters.at(-1) !== expected) {
        mismatchedDelimiter = true;
      } else {
        delimiters.pop();
      }
    }
  }

  let parseStatus: ProviderJsonTextDiagnostic["parseStatus"] = "invalid-json";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    parseStatus = isPlainObject(parsed) ? "object" : "json-non-object";
  } catch {
    // arch-guard:silent-catch-ok 结构诊断本身就是失败投影，不记录原始解析异常以免带出正文。
  }

  return {
    inputChars: inputText.length,
    trimmedChars: trimmed.length,
    startsWithObject: trimmed.startsWith("{"),
    endsWithObject: trimmed.endsWith("}"),
    objectDepth: delimiters.filter((delimiter) => delimiter === "{").length,
    arrayDepth: delimiters.filter((delimiter) => delimiter === "[").length,
    terminatedInString: inString,
    danglingEscape: inString && escaped,
    mismatchedDelimiter,
    rawControlCharactersInString,
    parseStatus,
  };
}

export function diagnoseRejectedProviderToolInput(
  finalValue: unknown,
  streamedDraft: Nullable<ProviderToolInputDraft>,
): RejectedProviderToolInputDiagnostic {
  const final = isString(finalValue)
    ? diagnoseProviderJsonText(finalValue)
    : undefined;
  const streamDraft = streamedDraft
    ? {
        ...diagnoseProviderJsonText(streamedDraft.inputText),
        inputEnded: streamedDraft.inputEnded,
        identicalToFinal:
          isString(finalValue) && streamedDraft.inputText === finalValue,
      }
    : undefined;

  return {
    final: toOptional(final),
    streamDraft: toOptional(streamDraft),
  };
}

/**
 * AI SDK 的 final `tool-call` 按契约应给出 object，但部分兼容网关会在输出达到上限时
 * 把尚未闭合的 JSON 原文作为 string 交出来。这里允许完整、可解析的双重序列化 JSON
 * 自愈；不完整或非 object 的值必须留在“未被接受的工具调用”路径，绝不能下发执行器。
 */
export function resolveProviderFinalToolInput(
  value: unknown,
): ProviderFinalToolInputResolution {
  if (isPlainObject(value))
    return {
      ok: true,
      input: value as Record<string, unknown>,
      reparsedString: false,
    };

  if (isString(value)) {
    const trimmed = value.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainObject(parsed))
        return {
          ok: true,
          input: parsed as Record<string, unknown>,
          reparsedString: true,
        };
    } catch {
      return {
        ok: false,
        reason: "final_tool_input_json_parse_failed",
        receivedType: "string",
        inputChars: value.length,
      };
    }
  }

  return {
    ok: false,
    reason: "final_tool_input_not_object",
    receivedType: isNull(value)
      ? "null"
      : isArray(value)
        ? "array"
        : typeof value,
    inputChars: isString(value) ? value.length : 0,
  };
}

/**
 * 部分 OpenAI-compatible 网关会同时发送完整的 tool-input delta 和损坏的 final
 * `tool-call.input` 字符串。final 值仍是首选权威；只有它无法解析，且流式参数明确收到
 * `tool-input-end` 并能逐字节解析为 object 时，才使用该完整副本。不修补未闭合 JSON，
 * 避免把被截断的写操作“补齐”后执行。
 */
export function resolveProviderExecutableToolInput(
  finalValue: unknown,
  streamedDraft: Nullable<ProviderToolInputDraft>,
): ProviderExecutableToolInputResolution {
  const finalResolution = resolveProviderFinalToolInput(finalValue);
  if (finalResolution.ok)
    return {
      ok: true,
      input: finalResolution.input,
      source: "final",
    };

  if (!streamedDraft?.inputEnded) return finalResolution;
  const streamedResolution = resolveProviderFinalToolInput(
    streamedDraft.inputText,
  );
  if (!streamedResolution.ok) return finalResolution;

  return {
    ok: true,
    input: streamedResolution.input,
    source: "ended-stream-draft",
  };
}

export function buildToolInputReadyMetadata(
  inputText: string,
): Record<string, unknown> {
  return {
    phase: "tool-input-ready",
    inputChars: inputText.length,
    streamedInput: true,
  };
}

export function summarizeProviderToolInputDraft(
  draft: ProviderToolInputDraft,
): Record<string, unknown> {
  return {
    id: draft.id,
    toolName: draft.toolName,
    providerToolName: draft.providerToolName,
    requestAdvertised: draft.requestAdvertised,
    inputChars: draft.inputText.length,
    inputTrimmedChars: draft.inputText.trim().length,
    inputEnded: draft.inputEnded,
  };
}

export function buildToolInputProtocolError(input: {
  reason: string;
  toolCallId: string;
  model: string;
  turn?: LooseOptional<number>;
  toolName?: LooseOptional<string>;
  finalToolName?: LooseOptional<string>;
}): AppError {
  const context: Record<string, unknown> = {
    source: "stream-tool-input",
    reason: input.reason,
    model: input.model,
    toolCallId: input.toolCallId,
  };
  if (isPresent(input.turn)) context.turn = input.turn;
  if (input.toolName) context.toolName = input.toolName;
  if (input.finalToolName) context.finalToolName = input.finalToolName;

  return new AppError(
    "MODEL_STREAM_INTERRUPTED",
    "模型流返回了不完整或冲突的工具调用身份，已中止本轮请求。",
    undefined,
    context,
  );
}

function resolveNonBlankProviderToolName(
  toolName: unknown,
  input: {
    reason: string;
    toolCallId: string;
    model: string;
    turn?: LooseOptional<number>;
    resolveToolName: (toolName: string) => ProviderToolNameResolution;
  },
): ProviderToolNameResolution {
  if (!isNonBlankString(toolName)) {
    throw buildToolInputProtocolError({
      reason: input.reason,
      toolCallId: input.toolCallId,
      model: input.model,
      turn: input.turn,
    });
  }

  return input.resolveToolName(toolName);
}

export function parseEndedProviderToolInputDraft(
  draft: ProviderToolInputDraft,
  input: {
    model: string;
    turn?: LooseOptional<number>;
  },
): Record<string, unknown> {
  return (
    parseProviderToolInputDraft(draft, input, {
      allowEmptyInput: true,
      allowIncompleteJson: false,
    }) ?? {}
  );
}

export function parseRecoverableProviderToolInputDraft(
  draft: ProviderToolInputDraft,
  input: {
    model: string;
    turn?: LooseOptional<number>;
  },
): Nullable<Record<string, unknown>> {
  return parseProviderToolInputDraft(draft, input, {
    allowEmptyInput: draft.inputEnded,
    allowIncompleteJson: !draft.inputEnded,
  });
}

function parseProviderToolInputDraft(
  draft: ProviderToolInputDraft,
  input: {
    model: string;
    turn?: LooseOptional<number>;
  },
  options: {
    allowEmptyInput: boolean;
    allowIncompleteJson: boolean;
  },
): Nullable<Record<string, unknown>> {
  const trimmed = draft.inputText.trim();
  if (!trimmed) return options.allowEmptyInput ? {} : null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (options.allowIncompleteJson) return null;

    throw buildToolInputProtocolError({
      reason: "tool_input_json_parse_failed",
      toolCallId: draft.id,
      toolName: draft.toolName,
      model: input.model,
      turn: input.turn,
    });
  }

  if (!isPlainObject(parsed)) {
    throw buildToolInputProtocolError({
      reason: "tool_input_json_not_object",
      toolCallId: draft.id,
      toolName: draft.toolName,
      model: input.model,
      turn: input.turn,
    });
  }

  return parsed;
}

export function resolveProviderFinalToolCallIdentity(
  drafts: Map<string, ProviderToolInputDraft>,
  input: {
    toolCallId: string;
    finalToolName: unknown;
    model: string;
    turn?: LooseOptional<number>;
    resolveToolName: (toolName: string) => ProviderToolNameResolution;
  },
): ProviderFinalToolCallIdentity {
  const draft = drafts.get(input.toolCallId);
  const finalResolution = isNonBlankString(input.finalToolName)
    ? input.resolveToolName(input.finalToolName)
    : null;

  if (!finalResolution && !draft) {
    throw buildToolInputProtocolError({
      reason: "final_tool_name_missing",
      toolCallId: input.toolCallId,
      model: input.model,
      turn: input.turn,
    });
  }

  const toolNameResolution: ProviderToolNameResolution =
    finalResolution ?? {
      toolName: draft!.toolName,
      providerToolName: draft!.providerToolName,
      requestAdvertised: draft!.requestAdvertised,
    };

  if (!draft) return { toolNameResolution, streamedInput: null };

  if (draft.toolName !== toolNameResolution.toolName) {
    throw buildToolInputProtocolError({
      reason: "tool_input_name_mismatch",
      toolCallId: input.toolCallId,
      toolName: draft.toolName,
      finalToolName: toolNameResolution.toolName,
      model: input.model,
      turn: input.turn,
    });
  }

  drafts.delete(input.toolCallId);
  return { toolNameResolution, streamedInput: draft };
}

type ProviderToolInputPartLike =
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string };

export function applyProviderToolInputStreamPart(
  part: { type: string },
  drafts: Map<string, ProviderToolInputDraft>,
  options: {
    model: string;
    turn?: LooseOptional<number>;
    markVisibleOutput: () => void;
    resolveToolName: (toolName: string) => ProviderToolNameResolution;
  },
): boolean {
  switch (part.type) {
    case "tool-input-start": {
      const inputPart = part as Extract<
        ProviderToolInputPartLike,
        { type: "tool-input-start" }
      >;
      if (drafts.has(inputPart.id)) {
        throw buildToolInputProtocolError({
          reason: "duplicate_tool_input_start",
          toolCallId: inputPart.id,
          toolName: inputPart.toolName,
          model: options.model,
          turn: options.turn,
        });
      }
      options.markVisibleOutput();
      const resolvedToolName = resolveNonBlankProviderToolName(
        inputPart.toolName,
        {
          reason: "tool_input_start_name_missing",
          toolCallId: inputPart.id,
          model: options.model,
          turn: options.turn,
          resolveToolName: options.resolveToolName,
        },
      );
      drafts.set(inputPart.id, {
        id: inputPart.id,
        ...resolvedToolName,
        inputText: "",
        inputEnded: false,
      });
      return true;
    }
    case "tool-input-delta": {
      const inputPart = part as Extract<
        ProviderToolInputPartLike,
        { type: "tool-input-delta" }
      >;
      options.markVisibleOutput();
      const draft = drafts.get(inputPart.id);
      if (!draft) {
        throw buildToolInputProtocolError({
          reason: "tool_input_delta_before_start",
          toolCallId: inputPart.id,
          model: options.model,
          turn: options.turn,
        });
      }
      if (draft.inputEnded) {
        throw buildToolInputProtocolError({
          reason: "tool_input_delta_after_end",
          toolCallId: inputPart.id,
          toolName: draft.toolName,
          model: options.model,
          turn: options.turn,
        });
      }
      draft.inputText += inputPart.delta;
      return true;
    }
    case "tool-input-end": {
      const inputPart = part as Extract<
        ProviderToolInputPartLike,
        { type: "tool-input-end" }
      >;
      const draft = drafts.get(inputPart.id);
      if (!draft) {
        throw buildToolInputProtocolError({
          reason: "tool_input_end_before_start",
          toolCallId: inputPart.id,
          model: options.model,
          turn: options.turn,
        });
      }
      if (draft.inputEnded) {
        throw buildToolInputProtocolError({
          reason: "duplicate_tool_input_end",
          toolCallId: inputPart.id,
          toolName: draft.toolName,
          model: options.model,
          turn: options.turn,
        });
      }
      draft.inputEnded = true;
      options.markVisibleOutput();
      return true;
    }
    default:
      return false;
  }
}
