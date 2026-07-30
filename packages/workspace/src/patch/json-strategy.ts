import { isArray, isEmpty, isPresent, optionalWhen, stringifyPretty } from "@velaros-ai/core";

import { WorkspaceError } from "../errors.js";
import type { PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { countChangedLines } from "../utils/text.js";

function pointerParts(pointer: string): string[] {
  if (isEmpty(pointer)) return [];
  if (!pointer.startsWith("/")) throw new WorkspaceError("INVALID_INPUT", `JSON pointer 无效：${pointer}`);
  return pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function setAt(root: any, pointer: string, value: any, mode: "add" | "replace" | "remove") {
  const parts = pointerParts(pointer);
  if (isEmpty(parts)) return optionalWhen(!(mode === "remove"), value);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!isPresent(cur[key])) cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  if (isArray(cur)) {
    const idx = last === "-" ? cur.length : Number(last);
    if (mode === "remove") cur.splice(idx, 1);
    else if (mode === "add") cur.splice(idx, 0, value);
    else cur[idx] = value;
  } else if (mode === "remove") delete cur[last];
    else cur[last] = value;
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
      if (!snap?.content) throw new WorkspaceError("TARGET_NOT_FOUND", "JSON patch 需要文本 snapshot");
      let data: any;
      try {
        data = JSON.parse(snap.content);
      } catch (error) {
        throw new WorkspaceError("VALIDATION_FAILED", `补丁前 JSON 无效：${(error as Error).message}`);
      }
      const op: any = input.intent.operation;
      for (const p of op.patches) {
        // schema 只允许 add/replace/remove。防御直连 kernel 的非法 op：显式拒绝，
        // 不能落到 replace 分支用错误语义静默改 JSON（RFC6902 的 move/copy/test 目前不在契约内）。
        if (p.op !== "add" && p.op !== "replace" && p.op !== "remove") {
          throw new WorkspaceError("INVALID_INPUT", `不支持的 json_patch 操作：${String(p.op)}（仅支持 add/replace/remove）`);
        }
        data = setAt(data, p.path, p.value, p.op);
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
