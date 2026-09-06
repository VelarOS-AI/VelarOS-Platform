import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNull,
  isObject,
  isPlainObject,
  isString,
  isUndefined,
  stringifyPretty,
} from "@velaros-ai/core";

import { ProjectError } from "../errors.js";
import type { JsonValue } from "../types/common.js";
import type { PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { countChangedLines } from "../utils/text.js";

type JsonContainer = JsonValue[] | { [key: string]: JsonValue };
type JsonPatch =
  | { op: "add" | "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string };

function patchError(
  patchIndex: number,
  patchPath: unknown,
  reason: string,
  message: string,
): never {
  const path = isString(patchPath) ? patchPath : String(patchPath);
  throw new ProjectError(
    "INVALID_INPUT",
    `json_patch[${patchIndex}] ${message}`,
    { patchIndex, path, reason },
    "请修正该 patch 的 JSON Pointer 或操作参数后重新准备事务。",
  );
}

function pointerParts(pointer: unknown, patchIndex: number): string[] {
  if (!isString(pointer)) {
    patchError(patchIndex, pointer, "invalid_pointer", "path 必须是 JSON Pointer 字符串。");
  }
  if (isEmpty(pointer)) return [];
  if (!pointer.startsWith("/")) {
    patchError(patchIndex, pointer, "invalid_pointer", `JSON Pointer 必须为空字符串或以 / 开头：${pointer}`);
  }
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/u.test(part)) {
      patchError(patchIndex, pointer, "invalid_pointer_escape", `JSON Pointer 含无效 ~ 转义：${pointer}`);
    }
    return part.replace(/~1/gu, "/").replace(/~0/gu, "~");
  });
}

function isJsonContainer(value: JsonValue): value is JsonContainer {
  return isArray(value) || isPlainObject(value);
}

function isStrictJsonValue(value: unknown): value is JsonValue {
  const seen = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (
      isNull(candidate)
      || isString(candidate)
      || isBoolean(candidate)
      || isFiniteNumber(candidate)
    ) return true;
    if (!isObject(candidate)) return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (isArray(candidate)) return candidate.every(visit);
    if (Object.getPrototypeOf(candidate) !== Object.prototype && !isNull(Object.getPrototypeOf(candidate)))
      return false;
    return Object.values(candidate).every(visit);
  };

  return visit(value);
}

function assertJsonValue(value: unknown, patchIndex: number, path: string): asserts value is JsonValue {
  if (!isStrictJsonValue(value)) {
    patchError(patchIndex, path, "value_not_json", "value 必须是可序列化的有限 JSON 值。");
  }
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function arrayIndex(
  token: string,
  length: number,
  mode: JsonPatch["op"],
  patchIndex: number,
  path: string,
): number {
  if (token === "-") {
    if (mode === "add") return length;
    patchError(patchIndex, path, "invalid_array_index", "- 只允许用于 add 到数组末尾。");
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
    patchError(patchIndex, path, "invalid_array_index", `数组索引无效：${token}`);
  }
  const index = Number(token);
  const maximum = mode === "add" ? length : length - 1;
  if (!Number.isSafeInteger(index) || index > maximum) {
    patchError(
      patchIndex,
      path,
      "array_index_out_of_bounds",
      `数组索引越界：${token}（${mode} 允许的最大索引为 ${maximum}）。`,
    );
  }
  return index;
}

function resolveParent(
  root: JsonValue,
  parts: string[],
  patchIndex: number,
  path: string,
): JsonContainer {
  let current = root;
  for (const token of parts.slice(0, -1)) {
    if (!isJsonContainer(current)) {
      patchError(patchIndex, path, "parent_not_container", `路径父节点不是对象或数组：${token}`);
    }
    if (isArray(current)) {
      const index = arrayIndex(token, current.length, "replace", patchIndex, path);
      current = current[index] as JsonValue;
      continue;
    }
    if (!Object.hasOwn(current, token)) {
      patchError(patchIndex, path, "parent_missing", `路径父节点不存在：${token}`);
    }
    current = current[token] as JsonValue;
  }
  if (!isJsonContainer(current)) {
    patchError(patchIndex, path, "parent_not_container", "目标父节点不是对象或数组。");
  }
  return current;
}

function applyPatch(root: JsonValue, patch: JsonPatch, patchIndex: number): JsonValue {
  const parts = pointerParts(patch.path, patchIndex);
  const allowedFields = new Set(patch.op === "remove" ? ["op", "path"] : ["op", "path", "value"]);
  const unexpectedField = Object.keys(patch).find((field) => !allowedFields.has(field));
  if (unexpectedField) {
    patchError(
      patchIndex,
      patch.path,
      "unexpected_field",
      `${patch.op} 含不支持的字段：${unexpectedField}`,
    );
  }
  if (patch.op !== "remove") {
    if (!Object.hasOwn(patch, "value") || isUndefined(patch.value)) {
      patchError(patchIndex, patch.path, "value_required", `${patch.op} 必须提供 value。`);
    }
    assertJsonValue(patch.value, patchIndex, patch.path);
  }

  if (isEmpty(parts)) {
    if (patch.op === "remove") {
      patchError(patchIndex, patch.path, "root_remove_unsupported", "不能删除整个 JSON 文档根节点。");
    }
    return cloneJsonValue(patch.value);
  }

  const parent = resolveParent(root, parts, patchIndex, patch.path);
  const token = parts.at(-1)!;
  if (isArray(parent)) {
    const index = arrayIndex(token, parent.length, patch.op, patchIndex, patch.path);
    if (patch.op === "remove") parent.splice(index, 1);
    else if (patch.op === "add") parent.splice(index, 0, cloneJsonValue(patch.value));
    else parent[index] = cloneJsonValue(patch.value);
    return root;
  }

  const targetExists = Object.hasOwn(parent, token);
  if (patch.op !== "add" && !targetExists) {
    patchError(patchIndex, patch.path, "target_missing", `${patch.op} 的目标属性不存在：${token}`);
  }
  if (patch.op === "remove") {
    delete parent[token];
  } else {
    Object.defineProperty(parent, token, {
      value: cloneJsonValue(patch.value),
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  return root;
}

export function jsonPatchStrategy(): PatchStrategy {
  return {
    id: "core.json-patch",
    priority: 50,
    canHandle(input: PatchStrategyInput) {
      return input.intent.operation.type === "json_patch";
    },
    prepare(input: PatchStrategyInput): PreparedPatch[] {
      const snap = input.snapshot;
      if (!snap || isUndefined(snap.content)) {
        throw new ProjectError("TARGET_NOT_FOUND", "JSON patch 需要文本 snapshot");
      }
      let data: JsonValue;
      try {
        data = JSON.parse(snap.content) as JsonValue;
      } catch (error) {
        throw new ProjectError("VALIDATION_FAILED", `补丁前 JSON 无效：${(error as Error).message}`);
      }
      if (!isStrictJsonValue(data)) {
        throw new ProjectError(
          "VALIDATION_FAILED",
          "补丁前 JSON 含不能安全写回的非有限数值。",
          { path: snap.path, reason: "document_not_json_value" },
          "请先把 NaN 或正负 Infinity 改为标准 JSON 值，再准备 JSON Patch。",
        );
      }
      const operation = input.intent.operation;
      if (operation.type !== "json_patch") {
        throw new ProjectError("INVALID_INPUT", "json patch strategy 收到非 json_patch 操作。");
      }
      const patches: unknown = operation.patches;
      if (!isArray(patches) || isEmpty(patches)) {
        patchError(-1, "", "patches_required", "patches 必须是非空数组。");
      }
      for (const [patchIndex, rawPatch] of patches.entries()) {
        if (!isPlainObject(rawPatch)) {
          patchError(patchIndex, "", "invalid_patch", "patch 必须是对象。");
        }
        const patch = rawPatch as JsonPatch;
        if (patch.op !== "add" && patch.op !== "replace" && patch.op !== "remove") {
          patchError(patchIndex, patch.path, "unsupported_op", `不支持的操作：${String(patch.op)}`);
        }
        data = applyPatch(data, patch, patchIndex);
      }
      const newContent = `${stringifyPretty(data)}\n`;
      const diff = unifiedDiff(snap.path, snap.content, newContent);
      const changedLines = countChangedLines(diff);
      const prepared: PreparedPatch = {
        patchId: id("patch"),
        strategyId: "core.json-patch",
        path: snap.path,
        baseRevision: snap.revision,
        oldContent: snap.content,
        newContent,
        diff,
        changedLines,
        risk: "low", // 规模不代表风险,统一 low(真正危险在操作层判定)
      };
      return [prepared];
    },
  };
}
