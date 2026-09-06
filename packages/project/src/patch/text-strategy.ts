import { isPresent, isTrue } from '@velaros-ai/core'

import { ProjectError } from "../errors.js";
import type { PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { adaptTextToContentLineEndings, countChangedLines, includesLineEndingAware, resolveLineEndingAwareTextMatch } from "../utils/text.js";

interface TextMatchSelectionOperation {
  expectedMatches?: number
  occurrence?: number
  replaceAll?: boolean
}

interface SelectedTextMatches {
  indices: number[]
  matchedText: string
  replacementText?: string
  totalMatches: number
}

function allMatchIndices(content: string, needle: string): number[] {
  const indices: number[] = []
  let from = 0
  while (true) {
    const index = content.indexOf(needle, from)
    if (index === -1) return indices
    indices.push(index)
    from = index + Math.max(1, needle.length)
  }
}

function selectTextMatches(
  input: PatchStrategyInput,
  operation: TextMatchSelectionOperation,
  content: string,
  needle: string,
  replacementText: Optional<string>,
  operationName: string,
): SelectedTextMatches {
  if (isPresent(operation.occurrence) && isTrue(operation.replaceAll)) {
    throw new ProjectError(
      "INVALID_INPUT",
      `${operationName} 的 occurrence 与 replaceAll 不能同时使用`,
      { occurrence: operation.occurrence, replaceAll: operation.replaceAll },
      "请只选择一个匹配位置，或明确修改全部匹配。",
    )
  }

  const found = resolveLineEndingAwareTextMatch(content, needle, replacementText)
  const expected = operation.expectedMatches
    ?? input.intent.constraints?.expectedMatches
    ?? input.target?.expectedMatches
  if (isPresent(expected) && found.count !== expected) {
    throw new ProjectError(
      found.count === 0 ? "TARGET_NOT_FOUND" : "AMBIGUOUS_TARGET",
      `${operationName} 断言 ${expected} 个匹配，实际找到 ${found.count} 个`,
      { expected, actual: found.count },
      "请重新读取文件并修正 expectedMatches；它只断言总数，不选择修改位置。",
    )
  }
  if (found.count === 0) {
    throw new ProjectError(
      "TARGET_NOT_FOUND",
      `${operationName} 未找到匹配文本`,
      { expected: expected ?? 1, actual: 0 },
      "请重新读取文件并使用当前内容中的精确文本。",
    )
  }

  const indices = allMatchIndices(content, found.matchedText)
  if (isPresent(operation.occurrence)) {
    if (!Number.isInteger(operation.occurrence) || operation.occurrence < 1 || operation.occurrence > indices.length) {
      throw new ProjectError(
        "TARGET_NOT_FOUND",
        `${operationName} 的 occurrence=${operation.occurrence} 超出 ${indices.length} 个匹配`,
        { occurrence: operation.occurrence, actual: indices.length },
        "请重新读取文件并选择现有的匹配序号。",
      )
    }
    return {
      indices: [indices[operation.occurrence - 1]],
      matchedText: found.matchedText,
      replacementText: found.replacementText,
      totalMatches: found.count,
    }
  }
  if (isTrue(operation.replaceAll))
    return {
      indices,
      matchedText: found.matchedText,
      replacementText: found.replacementText,
      totalMatches: found.count,
    }
  if (found.count !== 1) {
    throw new ProjectError(
      "AMBIGUOUS_TARGET",
      `${operationName} 找到 ${found.count} 个匹配，但未指定 occurrence 或 replaceAll`,
      { expected: expected ?? 1, actual: found.count },
      "请用 occurrence 选择一个 1-based 匹配，或传 replaceAll=true 修改全部匹配。",
    )
  }
  return {
    indices: [indices[0]],
    matchedText: found.matchedText,
    replacementText: found.replacementText,
    totalMatches: found.count,
  }
}

function replaceSelectedMatches(
  content: string,
  indices: readonly number[],
  matchedText: string,
  replacementText: string,
): string {
  let next = content
  for (const index of [...indices].reverse()) {
    next = next.slice(0, index) + replacementText + next.slice(index + matchedText.length)
  }
  return next
}

function patch(path: string, baseRevision: Optional<string>, oldContent: string, newContent: string, strategyId: string, metadata?: Record<string, any>): PreparedPatch {
  const diff = unifiedDiff(path, oldContent, newContent);
  const changedLines = countChangedLines(diff);
  return {
    patchId: id("patch"),
    strategyId,
    path,
    baseRevision,
    oldContent,
    newContent,
    diff,
    changedLines,
    risk: "low", // 规模不代表风险,统一 low(真正危险在操作层判定)
    metadata,
  };
}

export function textPatchStrategy(): PatchStrategy {
  return {
    id: "core.text-patch",
    priority: 10,
    canHandle(input: PatchStrategyInput) {
      return [
        "replace_text",
        "insert_text",
        "insert_text_at_anchor",
        "append_text",
        "prepend_text",
        "delete_text",
        "create_file",
        "delete_file",
        "rename_file",
      ].includes(input.intent.operation.type);
    },
    prepare(input: PatchStrategyInput): PreparedPatch[] {
      const op: any = input.intent.operation;
      if (op.type === "create_file") return [patch(op.path, undefined, "", op.content, "core.text-patch", { op: "create_file", overwrite: !!op.overwrite })];
      if (op.type === "delete_file") {
        const snap = input.snapshot;
        if (!snap?.exists) throw new ProjectError("TARGET_NOT_FOUND", `无法删除不存在的文件：${op.path}`);
        return [patch(op.path, snap.revision, snap.content ?? "", "", "core.text-patch", { op: "delete_file" })];
      }
      if (op.type === "rename_file") {
        const snap = input.snapshot;
        if (!snap?.exists) throw new ProjectError("TARGET_NOT_FOUND", `无法重命名不存在的文件：${op.from}`);
        return [
          patch(op.from, snap.revision, snap.content ?? "", "", "core.text-patch", { op: "rename_file_delete", to: op.to }),
          patch(op.to, undefined, "", snap.content ?? "", "core.text-patch", { op: "rename_file_create", from: op.from }),
        ];
      }

      const snap = input.snapshot;
      if (!snap) {
        const pathHint = input.target?.path ?? op?.path ?? op?.from ?? "(unknown path)";
        throw new ProjectError(
          "NOT_SUPPORTED",
          `text patch 需要已加载的文本 snapshot；当前操作没有可用 snapshot（路径提示：${pathHint}）。`,
          { operationType: op?.type, pathHint },
          "请确保操作能解析到文件路径或 targetId。先有界读取目标文件获取内容和 revision，再重新准备编辑事务。"
        );
      }
      if (snap.isBinary) {
        throw new ProjectError(
          "NOT_SUPPORTED",
          `text patch 不能编辑二进制文件（${snap.path}）。`,
          { path: snap.path },
          "请对二进制资源使用非文本工作流。"
        );
      }
      const content = snap.content ?? "";
      let start = input.target?.range?.startOffset;
      let end = input.target?.range?.endOffset;

      if (op.type === "replace_text") {
        let replacementText = op.newText;
        if (op.oldText) {
          const selected = selectTextMatches(input, op, content, op.oldText, op.newText, "replace_text");
          start = selected.indices[0];
          end = start + selected.matchedText.length;
          replacementText = selected.replacementText ?? op.newText;
          replacementText = adaptTextToContentLineEndings(
            selected.matchedText.includes("\r\n") ? selected.matchedText : content,
            replacementText,
          );
          // 针对已匹配文本窗口校验 anchors.mustContain。
          const anchors = op.anchors ?? input.target?.anchors;
          if (anchors?.mustContain) {
            const window = content.slice(start, end);
            for (const required of anchors.mustContain) {
              if (!includesLineEndingAware(window, required)) {
                throw new ProjectError(
                  "AMBIGUOUS_TARGET",
                  `replace_text 的 mustContain 锚点不满足：匹配文本中未找到 "${required}"`,
                  { required }
                );
              }
            }
          }
          const newContent = replaceSelectedMatches(
            content,
            selected.indices,
            selected.matchedText,
            replacementText,
          );
          return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", {
            op: "replace_text",
            startOffset: start,
            endOffset: end,
            matchedCount: selected.totalMatches,
            modifiedCount: selected.indices.length,
          })];
        }
        if (!isPresent(start) || !isPresent(end)) {
          throw new ProjectError("TARGET_NOT_FOUND", "replace_text 需要已解析目标范围或 oldText");
        }
        const replacedText = content.slice(start, end);
        replacementText = adaptTextToContentLineEndings(replacedText.includes("\r\n") ? replacedText : content, replacementText);
        const newContent = content.slice(0, start) + replacementText + content.slice(end);
        return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", { op: "replace_text", startOffset: start, endOffset: end })];
      }

      if (op.type === "insert_text") {
        if (!isPresent(start) || !isPresent(end)) throw new ProjectError("TARGET_NOT_FOUND", "insert_text 需要已解析目标范围");
        const at = op.position === "before" ? start : end;
        const insertionText = adaptTextToContentLineEndings(content, op.text);
        const newContent = content.slice(0, at) + insertionText + content.slice(at);
        return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", { op: "insert_text", startOffset: at, endOffset: at })];
      }

      if (op.type === "insert_text_at_anchor") {
        if (!op.anchorText) throw new ProjectError("INVALID_INPUT", "insert_text_at_anchor 需要 anchorText");
        const selected = selectTextMatches(
          input,
          op,
          content,
          op.anchorText,
          op.text,
          "insert_text_at_anchor",
        );
        const insertionText = adaptTextToContentLineEndings(
          selected.matchedText.includes("\r\n") ? selected.matchedText : content,
          selected.replacementText ?? op.text,
        );
        if (op.skipIfAlreadyPresent && (includesLineEndingAware(content, op.text) || content.includes(insertionText))) return [patch(snap.path, snap.revision, content, content, "core.text-patch", { op: "insert_text_at_anchor", noop: true })];
        const insertionOffsets = selected.indices.map((index) =>
          op.position === "before" ? index : index + selected.matchedText.length
        );
        const newContent = replaceSelectedMatches(content, insertionOffsets, "", insertionText);
        const at = insertionOffsets[0];
        return [
          patch(snap.path, snap.revision, content, newContent, "core.text-patch", {
            op: "insert_text_at_anchor",
            anchorText: selected.matchedText,
            position: op.position,
            startOffset: at,
            endOffset: at,
            matchedCount: selected.totalMatches,
            modifiedCount: selected.indices.length,
          }),
        ];
      }

      if (op.type === "append_text") {
        const appendedText = adaptTextToContentLineEndings(content, op.text);
        const newContent = op.skipIfAlreadyPresent && (includesLineEndingAware(content, op.text) || content.includes(appendedText)) ? content : content + appendedText;
        return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", { op: "append_text" })];
      }

      if (op.type === "prepend_text") {
        const prependedText = adaptTextToContentLineEndings(content, op.text);
        const newContent = op.skipIfAlreadyPresent && (includesLineEndingAware(content, op.text) || content.includes(prependedText)) ? content : prependedText + content;
        return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", { op: "prepend_text" })];
      }

      if (op.type === "delete_text") {
        if (op.oldText) {
          const selected = selectTextMatches(input, op, content, op.oldText, undefined, "delete_text");
          start = selected.indices[0];
          end = start + selected.matchedText.length;
          const newContent = replaceSelectedMatches(content, selected.indices, selected.matchedText, "");
          return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", {
            op: "delete_text",
            startOffset: start,
            endOffset: end,
            matchedCount: selected.totalMatches,
            modifiedCount: selected.indices.length,
          })];
        }
        if (!isPresent(start) || !isPresent(end)) throw new ProjectError("TARGET_NOT_FOUND", "delete_text 需要已解析目标范围或 oldText");
        const newContent = content.slice(0, start) + content.slice(end);
        return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", { op: "delete_text", startOffset: start, endOffset: end })];
      }

      throw new ProjectError("NOT_SUPPORTED", `不支持的文本操作：${op.type}`);
    },
  };
}
