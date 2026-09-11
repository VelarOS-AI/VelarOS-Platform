import {
  isArray,
  isNull,
  isNumber,
  isObject,
  isPlainObject,
  isPresent,
  isString,
  isUndefined,
  numberOrNull,
} from "@velaros-ai/core";
import { Log } from "@velaros-ai/core/logger";
import { isEmpty } from "@velaros-ai/core/utils/array";
import { mapDefined } from "@velaros-ai/core/utils/mapDefined";
import { toOptional } from "@velaros-ai/core/utils/nullish";
import { optionalWhenLazy } from "@velaros-ai/core/utils/optionalWhen";
import { readFirstString } from "@velaros-ai/core/utils/unknownJsonRecord";

interface ToolResultCompactionLimits {
  maxSerializedLength: number;
  maxStringLength: number;
  maxDepth: number;
  maxArrayItems: number;
  preserveLargeContent: boolean;
}

interface ToolInputCompactionLimits {
  maxSerializedLength: number;
  maxStringLength: number;
  maxArrayItems: number;
}

// 2026-07 真机取证（Downloads 整理会话 9 轮空转）后校准：8_000/50 会把一次 137 条目录列表
// 裁成 50 条,模型被迫 grep 分批+三连 recall 补查,一个 ls 级任务烧 9 轮。上限对齐业界
// agent CLI 的单发预算（~30K 字符）;历史膨胀由注意力路由/微压缩按压力回收,不在写入时预裁。
export const ModelToolResultMaxSerializedLength = 32_000;

const ModelToolResultLimits: ToolResultCompactionLimits = {
  maxSerializedLength: ModelToolResultMaxSerializedLength,
  maxStringLength: 2_000,
  maxDepth: 8,
  // 条目裁剪只是「海量小条目」的兜底,真正的预算闸门是 maxSerializedLength。
  // 曾为 12/50:与工具自身 truncated:false 矛盾、静默否决模型显式 limit（铁律⑦）,已放宽。
  maxArrayItems: 400,
  preserveLargeContent: false,
};

/**
 * 持久化/召回用全保真档位：serializedResult 是 context:recall 的唯一数据源,写入时裁剪
 * 等于永久销毁数据（第 51 条之后任何路径都取不回,真机已复现）。此档只做防爆兜底,
 * 模型视图的预算收敛交给 serializeToolResultForModel / sanitize 的回放重裁。
 */
const RecallToolResultLimits: ToolResultCompactionLimits = {
  maxSerializedLength: 400_000,
  maxStringLength: 16_000,
  maxDepth: 12,
  maxArrayItems: 5_000,
  preserveLargeContent: true,
};

const ToolSpaceResultOps = new Set(["find", "page", "map", "read", "replace"]);

const ToolSpaceModelResultLimits = {
  maxSerializedLength: 48_000,
  maxStringLength: 2_000,
  maxDepth: 18,
  maxArrayItems: 80,
} as const;

const DisplayToolResultLimits: ToolResultCompactionLimits = {
  maxSerializedLength: 60_000,
  maxStringLength: 1_200,
  maxDepth: 8,
  maxArrayItems: 20,
  preserveLargeContent: true,
};

const ModelToolInputLimits: ToolInputCompactionLimits = {
  maxSerializedLength: 12_000,
  maxStringLength: 900,
  // 结构化文档工具经常包含超过 12 个短块；若在 provider 历史中截断数组，模型会误判执行失败，
  // 进而重复追加页面。
  maxArrayItems: 100,
};

const LargeToolInputFieldThreshold = 240;
const WidgetCodeModelReplayMaxLength = 8_000;

const LargeToolInputKeys = new Set([
  "content",
  "data",
  "image",
  "base64",
  "latexSource",
  "widget_code",
  "html",
  "svg",
  "source",
  "newContent",
  "replacement",
  "replace",
]);

const ToolInputKeysWithoutPreview = new Set(["widget_code"]);

function isToolSpaceProtocolResult(result: unknown): boolean {
  if (!isPlainObject(result)) return false;

  const op = result["op"];
  if (!isString(op) || !ToolSpaceResultOps.has(op)) return false;

  return (
    isPresent(result["pages"]) ||
    isPresent(result["categories"]) ||
    isPresent(result["guide"]) ||
    isPresent(result["requiresApprovalDetails"]) ||
    isPresent(result["requiresUserActionDetails"]) ||
    isPresent(result["skippedPageDetails"]) ||
    isPresent(result["preparedTools"])
  );
}

function applyToolSpaceResultLimits(
  result: unknown,
  limits: ToolResultCompactionLimits,
): ToolResultCompactionLimits {
  if (!isToolSpaceProtocolResult(result)) return limits;

  // ContextOS 工具空间结果是“页表元数据”，不是普通业务输出。schema / activation /
  // dependencyRules 等深层结构会直接决定下一步工具换入参数，不能被
  // 通用浅层保护替换成 "[Depth limit reached]"。
  return {
    ...limits,
    maxSerializedLength: Math.max(
      limits.maxSerializedLength,
      ToolSpaceModelResultLimits.maxSerializedLength,
    ),
    maxStringLength: Math.max(
      limits.maxStringLength,
      ToolSpaceModelResultLimits.maxStringLength,
    ),
    maxDepth: Math.max(limits.maxDepth, ToolSpaceModelResultLimits.maxDepth),
    maxArrayItems: Math.max(
      limits.maxArrayItems,
      ToolSpaceModelResultLimits.maxArrayItems,
    ),
    preserveLargeContent: true,
  };
}

function appendJsonPathKey(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parent}.${key}`;

  return `${parent}[${JSON.stringify(key)}]`;
}

function appendJsonPathIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function describeTruncatedValueType(value: unknown): string {
  if (isArray(value)) return "array";
  if (isNull(value)) return "null";
  if (isObject(value)) return "object";

  return typeof value;
}

function buildDepthLimitMarker(
  value: unknown,
  jsonPath: string,
): Record<string, unknown> {
  const marker: Record<string, unknown> = {
    __truncated: true,
    reason: "depth-limit",
    jsonPath,
    omittedType: describeTruncatedValueType(value),
    // 统一召回 affordance 形(与折叠桩信封 retrieval 同构);<toolCallId> 由模型代入本次调用 id。
    retrieval: {
      tool: "context:recall",
      args: {
        ref: "<toolCallId>",
        refKind: "tool-payload",
        jsonPath,
        reason: `Read the full tool result payload and inspect ${jsonPath}.`,
      },
    },
  };

  if (isArray(value)) {
    marker.omittedLength = value.length;
    return marker;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    marker.omittedKeys = keys.slice(0, 12);
    if (keys.length > 12) marker.omittedKeyCount = keys.length;
  }

  return marker;
}

function cloneToolResult(
  value: unknown,
  depth: number,
  limits: ToolResultCompactionLimits,
  jsonPath = "$",
): unknown {
  if (depth > limits.maxDepth) {
    if (isPresent(value) && isObject(value))
      return buildDepthLimitMarker(value, jsonPath);

    return value;
  }

  if (!isPresent(value) || !isObject(value)) return value;

  if (isArray(value)) {
    const items = value
      .slice(0, limits.maxArrayItems)
      .map((item, index) =>
        cloneToolResult(
          item,
          depth + 1,
          limits,
          appendJsonPathIndex(jsonPath, index),
        ),
      );

    if (value.length > limits.maxArrayItems) {
      items.push({
        __truncatedItems: value.length - limits.maxArrayItems,
        jsonPath,
        nextOffset: limits.maxArrayItems,
      });
    }

    return items;
  }

  if (!isPlainObject(value)) return value;

  const record: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      key === "systemToolSuggestion" ||
      key === "capabilityAutoApprovalNotice" ||
      key === "userActionCards"
    ) {
      continue;
    }

    record[key] = cloneToolResult(
      nestedValue,
      depth + 1,
      limits,
      appendJsonPathKey(jsonPath, key),
    );
  }
  return record;
}

/**
 * 文件内容、diff 等大字段的 key 集合。
 * 展示侧保留这些字段的细节，模型侧仍会按预算压缩，避免工具结果撑爆上下文。
 */
const LargeContentKeys = new Set([
  "content",
  "diff",
  "stdout",
  "stderr",
  "excerpt",
  "preview",
  "matchedContent",
  "replacement",
  "widget_code",
  "patch",
  "newContent",
  "body",
]);

function trimToolResultStrings(
  value: unknown,
  depth: number,
  limits: ToolResultCompactionLimits,
  maxStringLength: number,
  parentKey?: string,
  preserveLargeContent = true,
): unknown {
  if (depth > limits.maxDepth) return value;

  if (isString(value)) {
    // 大内容字段豁免 maxStringLength，不在此处截断
    if (preserveLargeContent && parentKey && LargeContentKeys.has(parentKey))
      return value;
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…`
      : value;
  }

  if (!isPresent(value) || !isObject(value)) return value;

  if (isArray(value))
    return value.map((item) =>
      trimToolResultStrings(
        item,
        depth + 1,
        limits,
        maxStringLength,
        undefined,
        preserveLargeContent,
      ),
    );

  if (!isPlainObject(value)) return value;

  const record: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    record[key] = trimToolResultStrings(
      nestedValue,
      depth + 1,
      limits,
      maxStringLength,
      key,
      preserveLargeContent,
    );
  }
  return record;
}

function describeSerializationValue(value: unknown): Record<string, unknown> {
  const valueType = isNull(value) ? "null" : typeof value;
  const constructorName = isObject(value) ? value.constructor?.name : undefined;
  return {
    valueType,
    constructorName: toOptional(constructorName),
  };
}

function serializationErrorMessage(error: unknown): string {
  const message = readFirstString(
    error instanceof Error ? error.message : null,
    error,
  );
  if (message) return message;
  if (isNull(error))
    return "A null value was caught while serializing the tool result.";
  if (isUndefined(error))
    return "An undefined value was caught while serializing the tool result.";
  return String(error);
}

function stringifySerializationError(payload: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(payload);
    if (isString(serialized) && !isEmpty(serialized)) return serialized;
  } catch {
    // arch-guard:silent-catch-ok The fallback below is static JSON.
  }
  return '{"serializationError":true,"reason":"tool_result_serialization_fallback_failed","message":"Tool result serialization failed and the structured fallback could not be serialized."}';
}

function buildSerializationErrorResult(
  reason: string,
  message: string,
  value: unknown,
  error?: unknown,
): Record<string, unknown> {
  return {
    serializationError: true,
    reason,
    message,
    ...describeSerializationValue(value),
    errorName: optionalWhenLazy(
      error instanceof Error && error.name,
      () => (error as Error).name,
    ),
  };
}

function stringifyToolResult(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (isString(serialized) && serialized !== "null") return serialized;

    const reason = isString(serialized)
      ? "tool_result_returned_null"
      : "json_stringify_returned_undefined";
    const message = isString(serialized)
      ? "Tool returned top-level null; model-visible fallback inserted so the result is not silently lost."
      : "Tool result could not be serialized to JSON; model-visible fallback inserted.";
    return stringifySerializationError(
      buildSerializationErrorResult(reason, message, value),
    );
  } catch (error) {
    return stringifySerializationError(
      buildSerializationErrorResult(
        "json_stringify_threw",
        serializationErrorMessage(error),
        value,
        error,
      ),
    );
  }
}

function looksLikeBinaryPayload(value: string): boolean {
  if (value.startsWith("data:")) return true;

  return value.length > 2_000 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

// 只锚定开头：嵌套时内层 preview 被截到 160 字符，模型也会把占位头抄进真实参数后接真实内容，
// 两种情况都不以 "…]" 收尾，按整串匹配会漏掉它们，重放时又被再包一层。
const HistoryPreviewPlaceholderHeaderPattern =
  /^\[history preview omitted (\d+) chars from ("[^"]*"|string); tool received the full value(; preview: )?/;

// 单层占位串的体积上限：头部约 100 字符 + 160 字符 preview + "…]"，留有余量。只剥出一层却超过它，
// 说明头部后面跟的是真实内容而不是 preview：原样放行会绕过体积上限，交给常规压缩又会嵌套，
// 因此按剥离后的正文重建单层占位串。
const TrustedSinglePlaceholderMaxLength = 400;

interface ParsedHistoryPreviewPlaceholderHeader {
  length: string;
  field: string;
  hasPreview: boolean;
  rest: string;
}

function parseHistoryPreviewPlaceholderHeader(
  value: string,
): Nullable<ParsedHistoryPreviewPlaceholderHeader> {
  const match = value.match(HistoryPreviewPlaceholderHeaderPattern);
  if (!match) return null;

  return {
    length: match[1],
    field: match[2],
    hasPreview: isPresent(match[3]),
    rest: value.slice(match[0].length),
  };
}

// preview 正文固定以 "…]" 收尾（见 summarizeToolInputString）；不闭合说明这段文本本身
// 已经不是完整占位串（模型仿写头部时常见），原样保留，不强行拼出并不存在的收尾。
function stripPlaceholderTrailer(rest: string): string {
  return rest.endsWith("…]") ? rest.slice(0, -2) : rest;
}

const MaxHistoryPreviewUnwrapDepth = 8;

/**
 * 已压成占位串的历史参数在重放时保持单层：反复剥离开头的占位头，直到剩余文本不再以占位头开头。
 * 只有一层且体积可信时原样返回（重放幂等）；剥出多层、或一层却超出可信体积时，用剥离后的正文
 * 重建单层占位串——声明长度取本次实际收到的 value.length，预览取正文前 160 字符，输出有界且
 * 不随嵌套深度增长。不是占位串时返回 null，交给调用方走常规压缩。
 */
function collapseHistoryPreviewPlaceholder(value: string): Nullable<string> {
  const first = parseHistoryPreviewPlaceholderHeader(value);
  if (!first) return null;

  let layers = 1;
  let remainder = first.hasPreview
    ? stripPlaceholderTrailer(first.rest)
    : first.rest;

  for (let depth = 0; depth < MaxHistoryPreviewUnwrapDepth; depth++) {
    const next = parseHistoryPreviewPlaceholderHeader(remainder);
    if (!next) break;
    layers += 1;
    remainder = next.hasPreview ? stripPlaceholderTrailer(next.rest) : next.rest;
  }

  if (layers === 1 && value.length <= TrustedSinglePlaceholderMaxLength)
    return value;

  return historyPreviewPlaceholder(value.length, first.field, remainder);
}

/** 占位串的唯一格式：`summarizeToolInputString` 生成与 `collapseHistoryPreviewPlaceholder` 重建共用。 */
function historyPreviewPlaceholder(length: number, field: string, previewSource: string): string {
  const preview = previewSource.slice(0, 160).replaceAll(/\s+/g, " ").trim();
  return preview
    ? `[history preview omitted ${length} chars from ${field}; tool received the full value; preview: ${preview}…]`
    : `[history preview omitted ${length} chars from ${field}; tool received the full value]`;
}

function summarizeToolInputString(value: string, key?: string): string {
  const field = key ? `"${key}"` : "string";
  return historyPreviewPlaceholder(value.length, field, key && ToolInputKeysWithoutPreview.has(key) ? "" : value);
}

function buildTruncatedToolResult(
  serialized: string,
  maxSerializedLength: number,
): { compacted: unknown; serialized: string } {
  let previewLength = Math.max(0, maxSerializedLength - 160);

  while (previewLength >= 0) {
    const compacted = {
      __truncated: true,
      originalLength: serialized.length,
      preview:
        serialized.length > previewLength
          ? `${serialized.slice(0, previewLength)}…`
          : serialized,
      // 此层不知 toolCallId:<toolCallId> 由模型代入本次工具调用 id(与深度截断标记同约定)。
      retrieval: {
        tool: "context:recall",
        args: { ref: "<toolCallId>", refKind: "tool-payload" },
      },
    };
    const nextSerialized = stringifyToolResult(compacted);
    if (nextSerialized.length <= maxSerializedLength)
      return { compacted, serialized: nextSerialized };

    if (previewLength === 0) {
      break;
    }

    const overflow = nextSerialized.length - maxSerializedLength;
    previewLength = Math.max(0, previewLength - Math.max(overflow, 128));
  }

  const compacted = {
    __truncated: true,
    originalLength: serialized.length,
  };
  const nextSerialized = stringifyToolResult(compacted);

  if (nextSerialized.length <= maxSerializedLength)
    return { compacted, serialized: nextSerialized };

  return {
    compacted: { __truncated: true },
    serialized: '{"__truncated":true}',
  };
}

function compactToolInputValue(
  value: unknown,
  parentKey?: string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (isString(value)) {
    const collapsedPlaceholder = collapseHistoryPreviewPlaceholder(value);
    if (isPresent(collapsedPlaceholder)) return collapsedPlaceholder;

    if (
      parentKey === "widget_code" &&
      value.length <= WidgetCodeModelReplayMaxLength
    )
      return value;

    const isLikelyLargeToolField =
      !!parentKey &&
      LargeToolInputKeys.has(parentKey) &&
      value.length > LargeToolInputFieldThreshold;

    if (
      value.length > ModelToolInputLimits.maxStringLength ||
      isLikelyLargeToolField ||
      looksLikeBinaryPayload(value)
    )
      return summarizeToolInputString(value, parentKey);

    return value;
  }

  if (!isPresent(value) || !isObject(value)) return value;

  if (value instanceof ArrayBuffer)
    return `[omitted binary ArrayBuffer: ${value.byteLength} bytes]`;

  if (ArrayBuffer.isView(value))
    return `[omitted binary ${value.constructor.name}: ${value.byteLength} bytes]`;

  if (seen.has(value)) return "[Circular reference omitted]";
  seen.add(value);

  if (isArray(value)) {
    const items = value
      .slice(0, ModelToolInputLimits.maxArrayItems)
      .map((item) => compactToolInputValue(item, undefined, seen));

    if (value.length > ModelToolInputLimits.maxArrayItems) {
      items.push({
        __historyPreviewOmittedItems:
          value.length - ModelToolInputLimits.maxArrayItems,
        __toolReceivedFullInput: true,
        note: "History preview only; do not repeat the tool call because of this marker.",
      });
    }

    seen.delete(value);
    return items;
  }

  if (!isPlainObject(value)) {
    const constructorName = value.constructor?.name ?? "unknown";
    seen.delete(value);
    return `[omitted unsupported object: ${constructorName}]`;
  }

  const record: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    record[key] = compactToolInputValue(nestedValue, key, seen);
  }
  seen.delete(value);
  return record;
}

function compactToolResult(
  result: unknown,
  limits: ToolResultCompactionLimits,
): { compacted: unknown; serialized: string } {
  try {
    const cloned = cloneToolResult(result, 0, limits);
    let compacted = trimToolResultStrings(
      cloned,
      0,
      limits,
      limits.maxStringLength,
      undefined,
      limits.preserveLargeContent,
    );
    let serialized = stringifyToolResult(compacted);

    if (serialized.length <= limits.maxSerializedLength)
      return { compacted, serialized };

    let nextMaxStringLength = Math.max(
      limits.maxStringLength,
      limits.maxSerializedLength,
    );
    while (
      serialized.length > limits.maxSerializedLength &&
      nextMaxStringLength > 96
    ) {
      nextMaxStringLength = Math.max(96, Math.floor(nextMaxStringLength / 2));
      compacted = trimToolResultStrings(
        cloned,
        0,
        limits,
        nextMaxStringLength,
        undefined,
        false,
      );
      serialized = stringifyToolResult(compacted);
    }

    if (serialized.length <= limits.maxSerializedLength)
      return { compacted, serialized };

    return buildTruncatedToolResult(serialized, limits.maxSerializedLength);
  } catch (error) {
    Log.tag("toolResultSerialization").debug(
      "压缩工具结果失败，改用错误兜底结果",
      {
        error: serializationErrorMessage(error),
      },
    );
    const fallback = stringifySerializationError(
      buildSerializationErrorResult(
        "tool_result_compaction_failed",
        serializationErrorMessage(error),
        result,
        error,
      ),
    );
    if (fallback.length > limits.maxSerializedLength)
      return buildTruncatedToolResult(fallback, limits.maxSerializedLength);

    return {
      compacted: deserializeSerializedToolResult(fallback),
      serialized: fallback,
    };
  }
}

export function deserializeSerializedToolResult(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    // arch-guard:silent-catch-ok Plain strings are valid serialized tool results.
    return serialized;
  }
}

/**
 * 计算 read_file 内容预算：保留其他字段 JSON 封装后，留给 content 的字符数上限。
 * 根据 maxSerializedLength 动态调整，确保 content 预算与实际序列化上限一致。
 */
function calcReadFileContentBudget(maxSerializedLength: number): number {
  return Math.max(maxSerializedLength - 1_500, 1_000);
}

/**
 * 检测并修正 read_file 类型结果的元数据。
 *
 * 问题根因：工具返回 truncated:false + hasMore:false （文件实际已读完整），
 * 但序列化层把 content 截断成 700 字符后模型看到的 truncated 仍是 false，序列化层撥谎了元数据。
 * 修复：如果 content 超出模型内容预算，按完整行截断并同步更新 truncated / hasMore / returnedChars / nextStartLine。
 */
function fixReadFileMetadata(result: unknown, contentBudget: number): unknown {
  if (!isPlainObject(result)) return result;
  const r = result;
  const content = r["content"];
  const totalLines = r["totalLines"];
  if (!isString(content) || !isNumber(totalLines)) return result;
  if (content.length <= contentBudget) return result;

  // 按完整行截断，避免在行中间切断。
  const lines = content.split("\n");
  let budget = contentBudget;
  let keptLines = 0;
  for (const line of lines) {
    if (budget - line.length - 1 < 0) break;
    budget -= line.length + 1;
    keptLines++;
  }
  keptLines = Math.max(keptLines, 1);

  const truncatedContent = lines.slice(0, keptLines).join("\n");
  const startLine = isNumber(r["startLine"]) ? r["startLine"] : 1;
  const nextStartLine = startLine + keptLines;

  return {
    ...r,
    content: truncatedContent,
    truncated: true,
    hasMore: true,
    returnedChars: truncatedContent.length,
    nextStartLine,
  };
}

/**
 * 对 read_files 批量结果的 files 数组递归应用 fixReadFileMetadata。
 */
function fixReadFilesMetadata(result: unknown, contentBudget: number): unknown {
  if (!isPlainObject(result)) return result;
  const r = result;
  if (!isArray(r["files"])) return result;
  return {
    ...r,
    files: r["files"].map((f) => fixReadFileMetadata(f, contentBudget)),
  };
}

/**
 * 工具序列化提示：允许调用方传入工具输入参数中的大内容上限，
 * 序列化层据此动态放大 maxSerializedLength 并豁免大内容字段的字符串长度截断。
 */
export interface SerializationHints {
  /**
   * bash 的 maxOutputChars 参数；指定后序列化上限动态扩展到该值加 JSON 封装开销。
   */
  maxOutputChars?: number;
  /**
   * read_file / project:read 的 maxChars 或 maxBytes；指定后内容预算随之扩展。
   */
  maxChars?: number;
}

export function extractSerializationHintsFromToolInput(
  toolInput?: unknown,
): SerializationHints | undefined {
  if (!isPlainObject(toolInput)) return undefined;

  const input = toolInput;
  const maxOutputChars = toOptional(numberOrNull(input.maxOutputChars));
  const maxChars = isNumber(input.maxChars)
    ? input.maxChars
    : toOptional(numberOrNull(input.maxBytes));

  if (isPresent(maxOutputChars)) return { maxOutputChars };

  return mapDefined(maxChars, (n) => ({ maxChars: n }));
}

/**
 * 根据序列化提示计算实际使用的 limits。
 *
 * 逻辑：
 * - 若调用方传入 maxOutputChars 或 maxChars，则内容预算 = max(8000, hintValue + 2000)。
 * - 保留 maxStringLength 仅针对非大内容字段；大内容字段（content/stdout/stderr 等）
 *   通过 preserveLargeContent=true 豁免，仅受 maxSerializedLength 兜底控制。
 */
function buildModelLimitsWithHints(
  hints?: SerializationHints,
  result?: unknown,
): ToolResultCompactionLimits {
  const hintValue = hints?.maxOutputChars ?? hints?.maxChars;
  if (!hintValue || hintValue <= ModelToolResultMaxSerializedLength) {
    // 无 hints 或 hints 值不大于默认上限时，启用 preserveLargeContent
    // 避免 content/stdout 被 maxStringLength=700 截断（仍受 maxSerializedLength=8000 兜底）
    return applyToolSpaceResultLimits(result, {
      ...ModelToolResultLimits,
      preserveLargeContent: true,
    });
  }
  // 有效 hints：按 hintValue + 2000 字节 JSON 封装开销动态扩展
  const dynamicMax = hintValue + 2_000;
  return applyToolSpaceResultLimits(result, {
    ...ModelToolResultLimits,
    maxSerializedLength: dynamicMax,
    preserveLargeContent: true,
  });
}

export function serializeToolResultForModel(
  result: unknown,
  hints?: SerializationHints,
): string {
  // 先修正 read_file / project:read / read_files 等结果的元数据，再进行通用压缩序列化。
  const limits = buildModelLimitsWithHints(hints, result);
  const contentBudget = calcReadFileContentBudget(limits.maxSerializedLength);
  const preprocessed = fixReadFilesMetadata(
    fixReadFileMetadata(result, contentBudget),
    contentBudget,
  );
  return compactToolResult(preprocessed, limits).serialized;
}

/**
 * 全保真序列化：供 serializedResult 持久化（context:recall 的数据源）。
 * 与模型档的区别:不为省上下文预裁——数据完整性优先,预算收敛在读取侧做。
 */
export function serializeToolResultForRecall(result: unknown): string {
  return compactToolResult(result, RecallToolResultLimits).serialized;
}

export function compactToolInputForModel(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const compacted = compactToolInputValue(input);
  const record = isPlainObject(compacted) ? compacted : { input: compacted };
  const serialized = stringifyToolResult(record);

  if (serialized.length <= ModelToolInputLimits.maxSerializedLength)
    return record;

  return {
    __historyInputPreview: true,
    __toolReceivedFullInput: true,
    note: "The tool received the full input. This provider-history preview is shortened; do not repeat solely because of this marker.",
    preview: serialized.slice(0, ModelToolInputLimits.maxSerializedLength),
  };
}

export function compactToolResultForDisplay(result: unknown): unknown {
  return compactToolResult(result, DisplayToolResultLimits).compacted;
}
