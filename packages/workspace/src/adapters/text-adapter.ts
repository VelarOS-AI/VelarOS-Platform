import { isEmpty, isString,isTrue, optionalWhen } from "@velaros-ai/core";

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
      const caseInsensitive = !isTrue(input.caseSensitive);
      const regex = optionalWhen(input.regex, (new RegExp(input.query, caseInsensitive ? "gi" : "g")));
      if (regex) {
        // 正则搜索模拟 ripgrep 风格输出，但作为回退路径留在进程内执行。
        let match: Nullable<RegExpExecArray>;
        while ((match = regex.exec(content)) && hits.length < (input.maxResults ?? 20)) {
          const start = match.index;
          const end = start + match[0].length;
          hits.push({
            path: input.snapshot.path,
            score: 1,
            kind: "text",
            range: rangeFromOffsets(content, start, end),
            snippet: content.slice(Math.max(0, start - 120), Math.min(content.length, end + 120)),
            adapterId: "core.text",
          });
        }
        return hits;
      }
      let from = 0;
      const q = input.query;
      const haystack = caseInsensitive ? content.toLowerCase() : content;
      const needle = caseInsensitive ? q.toLowerCase() : q;
      while (hits.length < (input.maxResults ?? 20)) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        hits.push({
          path: input.snapshot.path,
          score: 1,
          kind: "text",
          range: rangeFromOffsets(content, index, index + needle.length),
          snippet: content.slice(Math.max(0, index - 120), Math.min(content.length, index + needle.length + 120)),
          adapterId: "core.text",
        });
        from = index + Math.max(1, needle.length);
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
        if (found.count === expected) return { status: "resolved", target: makeTarget(input.snapshot, { startOffset: found.index, endOffset: found.index + found.matchedText.length }, input, 0.99) };
        if (found.count > expected) {
          const candidates: ResolvedTarget[] = [];
          let from = 0;
          while (true) {
            const idx = content.indexOf(found.matchedText, from);
            if (idx === -1) break;
            candidates.push(makeTarget(input.snapshot, { startOffset: idx, endOffset: idx + found.matchedText.length }, input, 0.75));
            from = idx + found.matchedText.length;
          }
          return { status: "ambiguous", candidates, reason: `预期 ${expected} 个匹配，实际找到 ${found.count} 个` };
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
