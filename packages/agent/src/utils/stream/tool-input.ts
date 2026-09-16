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

import type { ProviderExecutableToolInputResolution, ProviderFinalToolCallIdentity, ProviderFinalToolInputResolution, ProviderJsonTextDiagnostic, ProviderToolInputDraft, ProviderToolInputPartLike,ProviderToolNameResolution, RejectedProviderToolInputDiagnostic } from '../../types/loop.js'

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

/**
 * 一次工具参数被拒之后，把 final 值与流式草稿各做一遍结构诊断并放在一起，便于判断是谁坏了。
 *
 * final 不是字符串（比如已经是对象、或干脆缺席）时不出 `final` 这一格；没有流式草稿时不出 `streamDraft`。
 * `identicalToFinal` 指出"两边是同一份坏文本"还是"供应方 final 与 delta 给了不同内容"——后者是
 * 部分兼容网关的已知分叉行为。全程只记结构事实，不带正文。
 */
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

/**
 * 工具参数流完时挂在事件上的元数据：阶段标记、参数字符数、以及"这份参数是流式收齐的"。
 * 只带长度不带正文——工具参数里常有整文件内容，进日志会直接爆量并带出源码。
 */
export function buildToolInputReadyMetadata(
  inputText: string,
): Record<string, unknown> {
  return {
    phase: "tool-input-ready",
    inputChars: inputText.length,
    streamedInput: true,
  };
}

/**
 * 把一份流式工具参数草稿摘成可记录的字段集：调用 id、归一后与供应方原始的工具名、是否在请求里声明过、
 * 参数字符数（含去空白后的长度）、以及是否已收到 `tool-input-end`。同样只出长度不出正文。
 */
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

/**
 * 造工具调用身份/参数协议违例的错误（统一 `MODEL_STREAM_INTERRUPTED`，本轮请求就此中止）。
 *
 * `reason` 是机读的违例码（如 `tool_input_delta_before_start`、`tool_input_name_mismatch`），
 * 连同模型、toolCallId、轮次一起进 context；toolName / finalToolName 有值才写，避免落一堆空字段。
 * 这类错刻意不做自愈：工具身份对不上时继续执行等于拿错参数调错工具。
 */
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

/**
 * 要求供应方给的工具名非空后再交给调用方的解析器（做别名归一等）。
 * 名字缺席或全是空白时按传入的 `reason` 抛协议违例——空工具名没有任何可回落的目标，
 * 猜一个只会把调用路由到错误的工具上。
 */
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

/**
 * 解析一份**已收到 `tool-input-end`** 的参数草稿：空参数合法（视作 `{}`，无参工具的正常形态），
 * 但 JSON 残缺或不是对象一律抛协议违例——流都结束了还不完整，只能是坏数据，不能补齐后执行。
 */
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

/**
 * 在流被中断等场景下尽力解析残留草稿，两档宽容度按是否已 `tool-input-end` 自动切换：
 * 已结束 → 空参数算 `{}`、但残缺 JSON 仍抛错；未结束 → 残缺 JSON 返回 null（本来就还没收完，不算错），
 * 空参数也返回 null。返回 null 表示"这份草稿现在不可用"，调用方据此丢弃而非执行。
 */
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

/**
 * 上面两个入口共用的解析实现：草稿文本 → 工具参数对象，宽容度全由 options 两个开关决定。
 *
 * 空文本按 `allowEmptyInput` 决定给 `{}` 还是 null；JSON 解析失败按 `allowIncompleteJson` 决定回 null
 * 还是抛 `tool_input_json_parse_failed`；解析出来不是对象则无论如何都抛 `tool_input_json_not_object`
 * （数组或标量当参数传给工具没有意义，且不像截断那样可能是"还没收完"）。
 */
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

/**
 * 收到 final `tool-call` 时定这次调用的身份，并把配对的流式草稿从 drafts 表里摘出来（**就地 delete**，
 * 交出所有权，避免同一个 id 被二次消费）。
 *
 * 优先用 final 给的工具名解析；final 没给名字就沿用草稿里记下的——部分供应方 final 分片只带 id 不带名字。
 * 两边都没有则抛 `final_tool_name_missing`；两边都有但对不上则抛 `tool_input_name_mismatch`
 * （身份分叉时执行任何一边都可能是错的，只能中止）。有名字但没有草稿是合法的：那是没有流式参数的调用，
 * 返回 `streamedInput: null`，参数由 final 值提供。
 */
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

/**
 * 把一个流分片喂给工具参数状态机，就地维护 drafts 表；**认领了返回 true，不是这三类分片返回 false**
 * 让调用方接着按自己的逻辑处理。
 *
 * 三类分片各自建/追加/封口一份草稿：`tool-input-start` 建（工具名必须非空，且同 id 不得重复 start）、
 * `tool-input-delta` 往 inputText 追加（必须先 start 过、且尚未 end）、`tool-input-end` 封口（必须存在且未封过）。
 * 任何一条时序不成立都抛协议违例中止本轮，不做容错拼接——乱序的参数拼出来的 JSON 无法判断是否完整。
 * 三类分片都会调 `markVisibleOutput`：工具调用属于"模型确实产出了东西"，否则会被空流检测误判为空响应。
 */
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
