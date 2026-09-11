import { isEmpty, isPresent, isString, isTrue, optionalWhen } from '@velaros-ai/core'

import { ProjectError } from "../errors.js";
import type { CreateFileOperation, PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import type { FileSnapshot } from "../types/snapshot.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { adaptTextToContentLineEndings, countChangedLines, includesLineEndingAware, offsetToLine, resolveLineEndingAwareTextMatch } from "../utils/text.js";
import {
  describeMatchLines,
  diagnoseTextMatchMiss,
  findLineWhitespaceTolerantMatches,
  locateTextMatches,
  summarizeTextMatchMiss,
  textMatchMissNextAction,
} from "../utils/text-match-feedback.js";

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
  /** 发生行尾空白宽容匹配时写入补丁 metadata，由 Agent 边界回显给模型。 */
  matchNote?: string
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

/**
 * 精确匹配为 0 时的唯一出路：忽略行尾空白与换行符后全文唯一、且与断言/occurrence 相容才宽容应用；
 * 否则抛出带最佳候选与首个分歧行的定位线索，让模型只修正出错的那一行。
 */
function selectMissingTextMatch(
  content: string,
  needle: string,
  replacementText: Optional<string>,
  operationName: string,
  expected: Optional<number>,
  occurrence: Optional<number>,
): SelectedTextMatches {
  const tolerant = findLineWhitespaceTolerantMatches(content, needle, 2)
  if (tolerant.length === 1 && (expected ?? 1) === 1 && (occurrence ?? 1) === 1) {
    const [match] = tolerant
    return {
      indices: [match.index],
      matchedText: match.text,
      // 换行符差异被宽容时 newText 的换行符不可信：先统一成 LF，再由调用方按被替换区域适配。
      replacementText: replacementText?.replace(/\r\n/g, "\n"),
      totalMatches: 1,
      matchNote: `${operationName} 的文本与文件第 ${offsetToLine(content, match.index)} 行起的内容仅在行尾空白或换行符（CRLF/LF）上不同；忽略这些差异后全文唯一，已按该位置修改。`,
    }
  }
  const diagnosis = diagnoseTextMatchMiss(content, needle)
  const tolerantLocations = locateTextMatches(content, tolerant.map((match) => match.index))
  const tolerantClue = isEmpty(tolerant)
    ? ""
    : `忽略行尾空白与换行符差异后可在${describeMatchLines(tolerantLocations, tolerant.length)}命中，但不唯一或与断言/occurrence 不符，未自动应用。`
  const headline = isPresent(expected)
    ? `${operationName} 断言 ${expected} 个匹配，实际找到 0 个`
    : `${operationName} 未找到匹配文本`
  throw new ProjectError(
    "TARGET_NOT_FOUND",
    `${headline}。${summarizeTextMatchMiss(diagnosis)}${tolerantClue}`,
    {
      expected: expected ?? 1,
      actual: 0,
      ...diagnosis,
      ...(isEmpty(tolerant) ? {} : { whitespaceTolerantMatches: tolerantLocations }),
    },
    textMatchMissNextAction(diagnosis),
  )
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
  if (found.count === 0)
    return selectMissingTextMatch(content, needle, replacementText, operationName, expected, operation.occurrence)

  const indices = allMatchIndices(content, found.matchedText)
  // 行号定位只在失败分支计算：成功路径不为诊断多扫一遍文件。
  const ambiguity = () => {
    const matches = locateTextMatches(content, indices)
    return { matches, lines: describeMatchLines(matches, indices.length) }
  }
  if (isPresent(expected) && found.count !== expected) {
    const { matches, lines } = ambiguity()
    throw new ProjectError(
      "AMBIGUOUS_TARGET",
      `${operationName} 断言 ${expected} 个匹配，实际找到 ${found.count} 个（${lines}）`,
      { expected, actual: found.count, matches },
      `expectedMatches 只断言文件中的匹配总数，不选择位置。只改其中一处：把 expectedMatches 改为 ${found.count}（或省略）并用 occurrence（1–${found.count}，按上述行号顺序）选择；全部修改：replaceAll=true；也可加长文本使其唯一。`,
    )
  }
  if (isPresent(operation.occurrence)) {
    if (!Number.isInteger(operation.occurrence) || operation.occurrence < 1 || operation.occurrence > indices.length) {
      const { matches, lines } = ambiguity()
      throw new ProjectError(
        "TARGET_NOT_FOUND",
        `${operationName} 的 occurrence=${operation.occurrence} 超出 ${indices.length} 个匹配（${lines}）`,
        { occurrence: operation.occurrence, actual: indices.length, matches },
        `occurrence 按文件中出现顺序从 1 计数，请在 1–${indices.length} 之间选择。`,
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
    const { matches, lines } = ambiguity()
    throw new ProjectError(
      "AMBIGUOUS_TARGET",
      `${operationName} 找到 ${found.count} 个匹配（${lines}），但未指定 occurrence 或 replaceAll`,
      { expected: expected ?? 1, actual: found.count, matches },
      `请用 occurrence（1–${found.count}，按上述行号顺序）选择一个匹配，或传 replaceAll=true 修改全部匹配。`,
    )
  }
  return {
    indices: [indices[0]],
    matchedText: found.matchedText,
    replacementText: found.replacementText,
    totalMatches: found.count,
  }
}

/**
 * 新文本的换行符跟随被替换的区域，区域不跨行时才跟随整个文件：混用换行符的文件里，
 * LF 区域不会被写入 CRLF，CRLF 区域也不会混入 LF。
 */
function lineEndingReference(content: string, matchedText: string): string {
  return matchedText.includes("\n") ? matchedText : content
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

/**
 * `create_file` 的目标以事务暂存视图判定：本事务前面删掉的算不存在，前面刚创建的算已存在。
 * 覆盖既有文件时补丁带上原文与 revision——rollback 据此写回原文而不是删除文件，apply 前原文
 * 被外部改动则按 base revision 冲突拒绝。取不到原文（二进制/超限）时 oldContent 留空，
 * 由 rollback 预检整体拒绝，绝不把原文件截成空。
 */
function createFilePatch(op: CreateFileOperation, snapshot: Optional<FileSnapshot>): PreparedPatch {
  const replaced = optionalWhen(isTrue(snapshot?.exists), snapshot);
  if (isPresent(replaced) && !isTrue(op.overwrite)) {
    throw new ProjectError(
      "CONFLICT_WITH_EXTERNAL_EDIT",
      `目标文件已存在，create_file 未开启 overwrite，拒绝覆盖：${op.path}`,
      { path: op.path, actual: replaced.revision },
      "整文件替换请改用 overwrite（project:write 的 mode=overwrite，或 create_file 的 overwrite=true）；只改局部内容请用 replace_text 等编辑操作；否则换一个不存在的路径。",
    );
  }
  const prepared = patch(op.path, snapshot?.revision, replaced?.content ?? "", op.content, "core.text-patch", {
    op: "create_file",
    overwrite: isTrue(op.overwrite),
    replacesExisting: isPresent(replaced),
  });
  return isPresent(replaced) && !isString(replaced.content) ? { ...prepared, oldContent: undefined } : prepared;
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
      if (op.type === "create_file") return [createFilePatch(op, input.snapshot)];
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
          replacementText = adaptTextToContentLineEndings(lineEndingReference(content, selected.matchedText), replacementText);
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
            matchNote: selected.matchNote,
          })];
        }
        if (!isPresent(start) || !isPresent(end)) {
          throw new ProjectError("TARGET_NOT_FOUND", "replace_text 需要已解析目标范围或 oldText");
        }
        const replacedText = content.slice(start, end);
        replacementText = adaptTextToContentLineEndings(lineEndingReference(content, replacedText), replacementText);
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
          lineEndingReference(content, selected.matchedText),
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
            matchNote: selected.matchNote,
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
            matchNote: selected.matchNote,
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
