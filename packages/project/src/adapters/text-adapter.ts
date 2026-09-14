import { isEmpty, isString, isTrue } from "@velaros-ai/core";

import type { AdapterSearchHit,FileAdapter, FileAdapterFactory } from "../types/adapter.js";
import type { FileSnapshot } from "../types/snapshot.js";
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from "../types/target.js";
import { id } from "../utils/id.js";
import { includesLineEndingAware, lineToOffset, rangeFromOffsets, resolveLineEndingAwareTextMatch } from "../utils/text.js";

/** 用原始 offset 构造绑定 revision 的目标，同时保留文本锚点供后续复核。 */
function makeTarget(snapshot: FileSnapshot, range: { startOffset: number; endOffset: number }, input: ResolveTargetInput, confidence: number, adapterId = "core.text"): ResolvedTarget {
  const exactSnippet = snapshot.content?.slice(range.startOffset, range.endOffset);
  const symbol = input.target?.symbol;
  return {
    targetId: id("target"),
    path: snapshot.path,
    baseRevision: snapshot.revision,
    sha256: snapshot.sha256,
    kind: symbol ? "symbol" : "range",
    range: rangeFromOffsets(snapshot.content ?? "", range.startOffset, range.endOffset),
    symbol: symbol
      ? {
          kind: symbol.kind ?? "unknown",
          name: symbol.name,
          container: symbol.container,
        }
      : undefined,
    anchors: {
      exactSnippet,
      before: input.target?.anchors?.before,
      after: input.target?.anchors?.after,
      mustContain: input.target?.anchors?.mustContain,
      startSnippet: exactSnippet?.slice(0, 80),
      endSnippet: exactSnippet?.slice(-80),
    },
    confidence,
    expectedMatches: input.expectedMatches ?? 1,
    adapterId,
  };
}

/** RegExp.exec 的空命中需要显式推进，边界始终落在完整 code point 之间。 */
function nextCodePointOffset(content: string, offset: number): number {
  const codePoint = content.codePointAt(offset);
  return offset + ((codePoint ?? 0) > 0xffff ? 2 : 1);
}

/** 依次将整串小写化后的偏移还原到原文；无需为整个大文件分配逐字符索引。 */
function createLowercaseOffsetMapper(content: string): (offset: number, endBoundary: boolean) => number {
  let sourceOffset = 0;
  let foldedOffset = 0;
  return (offset, endBoundary) => {
    while (sourceOffset < content.length && foldedOffset < offset) {
      const sourceEnd = nextCodePointOffset(content, sourceOffset);
      const foldedEnd = foldedOffset + content.slice(sourceOffset, sourceEnd).toLowerCase().length;
      // 大小写展开中的局部命中也必须引用整个原字符，不能生成半个字符的区间。
      if (offset < foldedEnd) return endBoundary ? sourceEnd : sourceOffset;
      sourceOffset = sourceEnd;
      foldedOffset = foldedEnd;
    }
    return sourceOffset;
  };
}

/** 通用纯文本 adapter，负责基础搜索、锚点解析和轻量校验。 */
export function createTextAdapter(): FileAdapter {
  return {
    id: "core.text",
    kind: "text",
    priority: 0,
    capabilities: ["read", "search", "resolve", "prepare_edit", "validate"],
    search(input): AdapterSearchHit[] {
      const content = input.snapshot.content ?? "";
      if (!content) return [];
      const hits: AdapterSearchHit[] = [];
      const limit = input.maxResults ?? 20;
      if (limit <= 0) return hits;
      const caseInsensitive = !isTrue(input.caseSensitive);
      const addHit = (start: number, end: number): void => {
        hits.push({
          path: input.snapshot.path,
          score: 1,
          kind: "text",
          range: rangeFromOffsets(content, start, end),
          snippet: content.slice(Math.max(0, start - 120), Math.min(content.length, end + 120)),
          adapterId: "core.text",
        });
      };
      if (input.regex || isEmpty(input.query)) {
        // 保持既有 JS 正则语法；仅显式正则（或空字面查询）创建 RegExp。
        const regex = new RegExp(input.query, caseInsensitive ? "gi" : "g");
        let match: Nullable<RegExpExecArray>;
        while (hits.length < limit && (match = regex.exec(content))) {
          addHit(match.index, match.index + match[0].length);
          if (isEmpty(match[0])) regex.lastIndex = nextCodePointOffset(content, regex.lastIndex);
        }
        return hits;
      }
      const haystack = caseInsensitive ? content.toLowerCase() : content;
      const needle = caseInsensitive ? input.query.toLowerCase() : input.query;
      // 整串转换保留 Greek final sigma 等上下文规则；展开时再按顺序映射回原文。
      const mapOffset = haystack.length === content.length
        ? (offset: number): number => offset
        : createLowercaseOffsetMapper(content);
      let from = 0;
      while (hits.length < limit) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        addHit(mapOffset(index, false), mapOffset(index + needle.length, true));
        from = index + needle.length;
      }
      return hits;
    },
    resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): ResolveTargetResult {
      const content = input.snapshot.content ?? "";
      if (input.baseRevision && input.baseRevision !== input.snapshot.revision) return { status: "not_found", reason: `baseRevision 不匹配：${input.baseRevision} != ${input.snapshot.revision}` };
      const exact = input.target?.exactSnippet;
      if (exact) {
        const found = resolveLineEndingAwareTextMatch(content, exact);
        const expected = input.expectedMatches ?? 1;
        if (found.count === 1 && expected === 1) return { status: "resolved", target: makeTarget(input.snapshot, { startOffset: found.index, endOffset: found.index + found.matchedText.length }, input, 0.99) };
        if (found.count > 0) {
          const candidates: ResolvedTarget[] = [];
          let from = 0;
          while (true) {
            const idx = content.indexOf(found.matchedText, from);
            if (idx === -1) break;
            candidates.push(makeTarget(input.snapshot, { startOffset: idx, endOffset: idx + found.matchedText.length }, input, 0.75));
            from = idx + found.matchedText.length;
          }
          return {
            status: "ambiguous",
            candidates,
            reason: found.count === expected
              ? `匹配总数断言通过，但 ${found.count} 个候选仍需明确选择`
              : `预期 ${expected} 个匹配，实际找到 ${found.count} 个`,
          };
        }
        return { status: "not_found", reason: "未找到精确片段" };
      }
      const anchors = input.target?.anchors;
      if (anchors?.before || anchors?.after || (!!anchors?.mustContain && !isEmpty(anchors.mustContain))) {
        // 锚点目标先选中 before/after 之间的文本，再校验 mustContain 提示。
        let start = 0;
        let end = content.length;
        if (anchors.before) {
          const found = resolveLineEndingAwareTextMatch(content, anchors.before);
          if (found.count === 0) return { status: "not_found", reason: "未找到 before 锚点" };
          start = found.index + found.matchedText.length;
        }
        if (anchors.after) {
          const found = resolveLineEndingAwareTextMatch(content.slice(start), anchors.after);
          if (found.count === 0) return { status: "not_found", reason: "未找到 after 锚点" };
          end = start + found.index;
        }
        const slice = content.slice(start, end);
        for (const must of anchors.mustContain ?? []) {
          if (!includesLineEndingAware(slice, must)) return { status: "not_found", reason: `范围内未找到 mustContain 锚点：${must}` };
        }
        return { status: "resolved", target: makeTarget(input.snapshot, { startOffset: start, endOffset: end }, input, 0.85) };
      }
      const hint = input.target?.lineHint;
      if (hint) {
        // 行号提示会随文件变化漂移，因此故意给较低置信度。
        const start = lineToOffset(content, hint.startLine);
        const end = lineToOffset(content, hint.endLine + 1);
        return { status: "resolved", target: makeTarget(input.snapshot, { startOffset: start, endOffset: end }, input, 0.55) };
      }
      return { status: "not_found", reason: "未提供 exactSnippet、anchors 或 lineHint" };
    },
    validate(input) {
      const content = input.changedContent ?? input.snapshot.content ?? "";
      return { ok: isString(content), diagnostics: [], checks: [{ id: "core.text", ok: true }] };
    },
  };
}

/** 面向所有可读非二进制文件的 factory；更强的 adapter 可用 priority 覆盖它。 */
export function textAdapterFactory(): FileAdapterFactory {
  return {
    id: "core.text.factory",
    canHandle(snapshot) {
      return snapshot.exists && !snapshot.isDirectory && !snapshot.isBinary;
    },
    create() {
      return createTextAdapter();
    },
  };
}
