import { isPresent } from '@velaros-ai/core'

import { ProjectError } from "../errors.js";
import type { PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { adaptTextToContentLineEndings, countChangedLines, includesLineEndingAware, resolveLineEndingAwareTextMatch } from "../utils/text.js";

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
          const found = resolveLineEndingAwareTextMatch(content, op.oldText, op.newText);
          const expected = input.intent.constraints?.expectedMatches ?? input.target?.expectedMatches ?? 1;
          if (found.count !== expected) {
            throw new ProjectError(
              found.count === 0 ? "TARGET_NOT_FOUND" : "AMBIGUOUS_TARGET",
              `replace_text 预期 ${expected} 个匹配，实际找到 ${found.count} 个`,
              { expected, actual: found.count },
              "请使用更具体的锚点或精确片段重新解析目标。"
            );
          }
          start = found.index;
          end = found.index + found.matchedText.length;
          replacementText = found.replacementText ?? op.newText;
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
        const found = resolveLineEndingAwareTextMatch(content, op.anchorText, op.text);
        const expected = op.expectedMatches ?? 1;
        if (found.count !== expected) {
          throw new ProjectError(
            found.count === 0 ? "TARGET_NOT_FOUND" : "AMBIGUOUS_TARGET",
            `insert_text_at_anchor 预期 ${expected} 个锚点匹配，实际找到 ${found.count} 个`,
            { expected, actual: found.count },
            "请使用更具体的 anchorText，或重新读取文件后选择其它操作。"
          );
        }
        const insertionText = found.replacementText ?? op.text;
        if (op.skipIfAlreadyPresent && (includesLineEndingAware(content, op.text) || content.includes(insertionText))) return [patch(snap.path, snap.revision, content, content, "core.text-patch", { op: "insert_text_at_anchor", noop: true })];
        const at = op.position === "before" ? found.index : found.index + found.matchedText.length;
        const newContent = content.slice(0, at) + insertionText + content.slice(at);
        return [
          patch(snap.path, snap.revision, content, newContent, "core.text-patch", {
            op: "insert_text_at_anchor",
            anchorText: found.matchedText,
            position: op.position,
            startOffset: at,
            endOffset: at,
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
          const found = resolveLineEndingAwareTextMatch(content, op.oldText);
          const expected = input.intent.constraints?.expectedMatches ?? input.target?.expectedMatches ?? 1;
          if (found.count !== expected) {
            throw new ProjectError(
              found.count === 0 ? "TARGET_NOT_FOUND" : "AMBIGUOUS_TARGET",
              `delete_text 预期 ${expected} 个匹配，实际找到 ${found.count} 个`,
              { expected, actual: found.count },
              "请使用更具体的锚点或精确片段重新解析目标。"
            );
          }
          start = found.index;
          end = found.index + found.matchedText.length;
        }
        if (!isPresent(start) || !isPresent(end)) throw new ProjectError("TARGET_NOT_FOUND", "delete_text 需要已解析目标范围或 oldText");
        const newContent = content.slice(0, start) + content.slice(end);
        return [patch(snap.path, snap.revision, content, newContent, "core.text-patch", { op: "delete_text", startOffset: start, endOffset: end })];
      }

      throw new ProjectError("NOT_SUPPORTED", `不支持的文本操作：${op.type}`);
    },
  };
}
