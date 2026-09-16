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

import { AgentToolLimits } from '../../contract/constants.js'
import type { SerializationHints,ToolResultCompactionLimits } from '../../types/tools.js'
import { AgentTuning } from '../tuning'

import { fitProjectReadsForModel, hasProjectSourceWindows } from './project-read-serialization';
import { projectToolInputForHistory } from './tool-input-history-projection';

// 2026-07 真机取证（Downloads 整理会话 9 轮空转）后校准：8_000/50 会把一次 137 条目录列表
// 裁成 50 条,模型被迫 grep 分批+三连 recall 补查,一个 ls 级任务烧 9 轮。上限对齐业界
// agent CLI 的单发预算（~30K 字符）;历史膨胀由注意力路由/微压缩按压力回收,不在写入时预裁。
// 值在 AgentToolLimits.payload.modelToolResultChars（写进工具结果句柄说明，模型看得到）。
export const ModelToolResultMaxSerializedLength: number = AgentToolLimits.payload.modelToolResultChars;

const ModelToolResultLimits: ToolResultCompactionLimits = {
  maxSerializedLength: ModelToolResultMaxSerializedLength,
  maxStringLength: 2_000,
  maxDepth: AgentTuning.tools.modelResultDepth,
  // 条目裁剪只是「海量小条目」的兜底,真正的预算闸门是 maxSerializedLength。
  // 曾为 12/50:与工具自身 truncated:false 矛盾、静默否决模型显式 limit（铁律⑦）,已放宽。
  maxArrayItems: AgentTuning.tools.modelResultArrayItems,
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
  maxDepth: AgentTuning.tools.recallResultDepth,
  maxArrayItems: AgentTuning.tools.recallResultArrayItems,
  preserveLargeContent: true,
};

const ToolSpaceResultOps = new Set(["find", "page", "map", "read", "replace"]);

const ToolSpaceModelResultLimits = {
  maxSerializedLength: 48_000,
  maxStringLength: 2_000,
  maxDepth: AgentTuning.tools.toolSpaceResultDepth,
  maxArrayItems: AgentTuning.tools.toolSpaceResultArrayItems,
} as const;

const DisplayToolResultLimits: ToolResultCompactionLimits = {
  maxSerializedLength: 60_000,
  maxStringLength: 1_200,
  maxDepth: AgentTuning.tools.displayResultDepth,
  maxArrayItems: AgentTuning.tools.displayResultArrayItems,
  preserveLargeContent: true,
};

/**
 * 判断这份结果是不是 ContextOS 工具空间协议的返回（tooling:find/page/map/read/replace 那一族）。
 * 认定条件：顶层是纯对象、`op` 是上述五个操作之一，且至少带 pages / categories / guide /
 * requiresApprovalDetails / requiresUserActionDetails / skippedPageDetails / preparedTools 其一。
 * 为真的结果会走更宽的压缩档（见 applyToolSpaceResultLimits）——它是页表元数据，裁深了模型下一步就不知道该怎么换页。
 */
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

/**
 * 结果是工具空间页表时把压缩限额放宽到「原限额与 ToolSpaceModelResultLimits 逐项取大」，并强制 `preserveLargeContent: true`；
 * 不是页表就原样返回传入的限额。
 * 只放宽不收紧：调用方给的档位若本来就更宽（例如展示档）不会被这条规则压回去。理由见函数体内注释——
 * schema / activation / dependencyRules 这些深层结构直接决定模型下一步换入什么工具，被浅层保护替成 "[Depth limit reached]" 就等于断了路。
 */
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

/**
 * 往 jsonPath 上接一段对象键：合法标识符用点号（`$.foo`），否则用带引号的方括号（`$["a-b"]`）。
 * 这条路径会原样写进截断标记，模型拿它当 context:recall 的 jsonPath 续读，所以必须是可直接回填的合法表达式。
 */
function appendJsonPathKey(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parent}.${key}`;

  return `${parent}[${JSON.stringify(key)}]`;
}

/**
 * 往 jsonPath 上接一段数组下标（`$.items[3]`）；与 appendJsonPathKey 成对，供截断标记里的召回路径使用。
 */
function appendJsonPathIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/**
 * 给被裁掉的值起一个类型名写进截断标记：数组 → `"array"`、null → `"null"`、其余对象 → `"object"`，基础类型用 `typeof` 的结果。
 * 单列 array/null 是因为 `typeof` 对它们都只会给 `"object"`，模型据此判断不出该不该继续展开。
 */
function describeTruncatedValueType(value: unknown): string {
  if (isArray(value)) return "array";
  if (isNull(value)) return "null";
  if (isObject(value)) return "object";

  return typeof value;
}

/**
 * 造一块替换掉「超过深度上限的子树」的占位标记：`__truncated/reason: 'depth-limit'/jsonPath/omittedType`，
 * 外加一段 `retrieval` 召回指引（context:recall + 该 jsonPath，ref 用 `<toolCallId>` 占位由模型代入本次调用 id）。
 * 数组另记 `omittedLength`，纯对象另记前 12 个键名 `omittedKeys`（超过 12 个再补 `omittedKeyCount`），
 * 让模型不展开也能判断这块值不值得召回。裁掉的子树在完整 serializedResult 里仍在，沿 jsonPath 可原样取回。
 */
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

/**
 * 按限额递归深拷工具结果的结构：超过 `maxDepth` 的对象/数组换成可召回的深度截断标记（基础类型原样保留），
 * 数组只留前 `maxArrayItems` 项并在尾部追加 `{ __truncatedItems, jsonPath, nextOffset }`——模型照这个标记用 context:recall + jsonPath + nextOffset 就能续读后面的条目。
 * 遍历同时剥掉三个只给宿主 UI 用的副作用键（systemToolSuggestion / capabilityAutoApprovalNotice / userActionCards），它们不该占模型上下文。
 * 非纯对象（Date、类实例等）不拆解、原样传下去，交给后面的 JSON.stringify 处理。这一步只裁结构，字符串长度由 trimToolResultStrings 管。
 */
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

/**
 * 递归把结果里的字符串截到 `maxStringLength`（超出补 `…`），深度超过 `limits.maxDepth` 的子树原样返回不再下探。
 * `preserveLargeContent` 为真时，直接挂在 LargeContentKeys（content/diff/stdout/stderr/patch 等）下的字符串整条豁免——
 * 这些正是模型真正要读的正文，截成几百字符等于白读；它们的体积兜底交给 maxSerializedLength 那一层。
 * 注意豁免只认「父键」：数组元素的 parentKey 传 undefined，所以 `content: [...]` 里的字符串不豁免。
 * 这里截掉的字符在本视图内不可召回，完整正文在全保真档的 serializedResult 里。
 */
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

/**
 * 序列化失败时描述「失败在什么值上」：给出 `valueType`（null 单列，其余按 typeof）与对象的 `constructorName`。
 * 拿不到构造器名时整个键不出现。只取类型不取内容——正文本身可能就是序列化不了的那个东西。
 */
function describeSerializationValue(value: unknown): Record<string, unknown> {
  const valueType = isNull(value) ? "null" : typeof value;
  const constructorName = isObject(value) ? value.constructor?.name : undefined;
  return {
    valueType,
    constructorName: toOptional(constructorName),
  };
}

/**
 * 从捕获到的任意抛出物里抠一句人话错误信息：优先 `Error.message`，否则把它自身当字符串读；
 * 都拿不到时 null / undefined 各给一句固定说明，其余回退到 `String(error)`。保证永远返回非空字符串，不会再抛。
 */
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

/**
 * 把「序列化失败说明」本身序列化成字符串；连这一步都失败（或得到空串）时返回一段写死的静态 JSON 兜底。
 * 存在意义是保证这条链路绝不再抛第二次错——工具结果哪怕全丢，也得给模型留一句能读的失败说明，而不是让整轮崩掉。
 */
function stringifySerializationError(payload: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(payload);
    if (isString(serialized) && !isEmpty(serialized)) return serialized;
  } catch {
    // arch-guard:silent-catch-ok 下面的回退是静态 JSON。
  }
  return '{"serializationError":true,"reason":"tool_result_serialization_fallback_failed","message":"Tool result serialization failed and the structured fallback could not be serialized."}';
}

/**
 * 拼一份给模型看的序列化失败结果体：`serializationError: true` + 机器码 reason + 人话 message + 出错值的类型描述，
 * 抛出物是 Error 且有 name 时附 `errorName`（否则该键不出现）。
 * 它是模型唯一能看到的「这次结果为什么没正文」的解释，所以只带类型与原因，不带可能本身就有问题的原值。
 */
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

/**
 * `JSON.stringify` 的不抛错版本，三种坏情况都换成模型可见的失败说明而不是静默丢结果：
 * 结果本身是顶层 null → `tool_result_returned_null`；stringify 返回 undefined（函数、undefined 等）→ `json_stringify_returned_undefined`；
 * stringify 抛错（循环引用、BigInt、toJSON 出错）→ `json_stringify_threw` 并带上原始错误信息。
 * 永远返回一个非空的合法 JSON 字符串。
 */
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

/**
 * 常规压缩仍然超预算时的最后一手：把整份已序列化文本换成 `{ __truncated, originalLength, preview, retrieval }` 存根，
 * preview 先按 `maxSerializedLength - 160` 取头部，序列化后仍超就按实际溢出量（每轮至少砍 128）缩短预览再试，直到装得下。
 * 预览缩到 0 还装不下就退成只有 `__truncated + originalLength`，再不行退成写死的 `{"__truncated":true}`（保证一定有返回，不会死循环）。
 * 存根里的 retrieval 指向 context:recall（ref 用 `<toolCallId>` 占位），完整正文仍在归档里可整份召回。
 */
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

/**
 * 按给定档位把工具结果压进预算，同时给出压缩后的值与其序列化文本。
 * 三级递进：① cloneToolResult 裁结构 + trimToolResultStrings 裁字符串，装得下就收工；
 * ② 仍超预算就对同一份结构反复重裁字符串，长度每轮对半砍（下限 96）并关掉大内容豁免；
 * ③ 还超就整份换成 buildTruncatedToolResult 的可召回存根。
 * 全程任何异常都不外抛：记一条 debug 日志后改吐序列化失败说明（说明本身超预算也会被压成存根）。
 * 裁掉的内容在这一份视图里不可召回，但全保真档的 serializedResult 未被裁，模型可用 context:recall 取回。
 */
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

/**
 * 把归档的 serializedResult 解回原值：能 `JSON.parse` 就 parse，parse 不了就把这段文本本身当结果返回。
 * 后一种不是错误分支——工具本来就允许返回纯字符串，序列化时是原样落盘的（见 serializeOutput）。
 */
export function deserializeSerializedToolResult(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    // arch-guard:silent-catch-ok 纯字符串本身就是合法的序列化工具结果。
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
  if (isPlainObject(r["snapshot"])) return result;
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
 * 从模型这次的工具入参里读出它自己要的输出体量：认 `maxOutputChars`（优先），否则认 `maxChars`，再否则把 `maxBytes` 当字符数用。
 * 入参不是纯对象、或三个字段都没有/不是数字时返回 undefined（表示走默认档）。
 * 有了这条提示，模型显式要更大输出时序列化层才会放宽预算，而不是静默否决它的 limit。
 */
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

/**
 * 产出直接进模型上下文的那份工具结果文本：先按 hints 与结果形态定档，再修 read_file / read_files / project:read 的元数据
 * （内容被裁时同步把 truncated/hasMore/returnedChars/nextStartLine 改对，不让序列化层替工具撒谎），最后统一压缩。
 * 结果带源码窗口时走快路：窗口已按整行分好预算，只要整体装得下就直接 JSON.stringify——
 * 通用的字符串截断和数组裁剪会改动原文或留下对不上的续读位置，对源码来说比省下的字符更伤。
 * 装不下才回到 compactToolResult 的通用压缩，被裁部分仍可经 context:recall 从全保真归档取回。
 */
export function serializeToolResultForModel(
  result: unknown,
  hints?: SerializationHints,
): string {
  // 先修正 read_file / project:read / read_files 等结果的元数据，再进行通用压缩序列化。
  const limits = buildModelLimitsWithHints(hints, result);
  const contentBudget = calcReadFileContentBudget(limits.maxSerializedLength);
  const preprocessed = fixReadFilesMetadata(
    fixReadFileMetadata(fitProjectReadsForModel(result, limits.maxSerializedLength - 512), contentBudget),
    contentBudget,
  );
  // 源码行记录已经共享准确预算；通用字符串和数组裁剪可能
  // 改变原文，或在删去行记录后留下不对应的续读位置。
  if (hasProjectSourceWindows(preprocessed)) {
    const serialized = JSON.stringify(preprocessed);
    if (serialized.length <= limits.maxSerializedLength) return serialized;
  }
  return compactToolResult(preprocessed, limits).serialized;
}

/**
 * 全保真序列化：供 serializedResult 持久化（context:recall 的数据源）。
 * 与模型档的区别:不为省上下文预裁——数据完整性优先,预算收敛在读取侧做。
 */
export function serializeToolResultForRecall(result: unknown): string {
  return compactToolResult(result, RecallToolResultLimits).serialized;
}

/**
 * 把一次工具调用的入参压成回放进模型历史的那一份，直接转交 `projectToolInputForHistory`。
 * 给了 `toolCallId` 时被摘掉的大字段会留下可 context:recall 的句柄，模型需要原参数时还能取回。
 */
export function compactToolInputForModel(
  input: Record<string, unknown>,
  toolCallId?: string,
): Record<string, unknown> {
  return projectToolInputForHistory(input, toolCallId);
}

/**
 * 压出给界面展示用的那一份结果（返回压缩后的值而非字符串）。
 * 用的是展示档：总长更宽（60K）、字符串更短（1.2K）、数组只留 20 项，但保留大内容字段——
 * 人眼要的是「看得见正文、列表不刷屏」，与模型档的取舍正好相反；这份不进模型上下文。
 */
export function compactToolResultForDisplay(result: unknown): unknown {
  return compactToolResult(result, DisplayToolResultLimits).compacted;
}
