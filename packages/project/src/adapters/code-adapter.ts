import { isEmpty,isTrue } from "@velaros-ai/core";

import type { FileAdapter, FileAdapterFactory, SymbolInfo } from "../types/adapter.js";
import type { FileSnapshot } from "../types/snapshot.js";
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from "../types/target.js";
import { id } from "../utils/id.js";
import { ext } from "../utils/path.js";
import { rangeFromOffsets } from "../utils/text.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".php", ".rb", ".swift", ".kt"]);

function findCodeSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "function", regex: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g },
    { kind: "class", regex: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g },
    { kind: "function", regex: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g },
    { kind: "function", regex: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm },
    { kind: "class", regex: /^\s*class\s+([A-Za-z_][\w]*)\b/gm },
    { kind: "function", regex: /func\s+([A-Za-z_][\w]*)\s*\(/g },
    { kind: "function", regex: /fn\s+([A-Za-z_][\w]*)\s*\(/g },
  ];
  for (const { kind, regex } of patterns) {
    let match: Nullable<RegExpExecArray>;
    while ((match = regex.exec(content))) {
      const start = match.index;
      const lineEnd = content.indexOf("\n", start);
      symbols.push({ kind, name: match[1], range: rangeFromOffsets(content, start, lineEnd === -1 ? content.length : lineEnd), signatureHash: undefined });
    }
  }
  return symbols.sort((a, b) => (a.range.startOffset ?? 0) - (b.range.startOffset ?? 0));
}

function expandCodeBlock(content: string, startOffset: number): { startOffset: number; endOffset: number } {
  const lineEnd = content.indexOf("\n", startOffset);
  const signatureEnd = lineEnd === -1 ? content.length : lineEnd + 1;
  const open = content.indexOf("{", startOffset);
  if (open !== -1 && open < signatureEnd + 200) {
    let depth = 0;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      if (content[i] === "}") {
        depth--;
        if (depth === 0) return { startOffset, endOffset: i + 1 };
      }
    }
  }
  // 缩进式语言的回退逻辑：扩展到空行、反缩进或新的 def/class 之前。
  const after = content.slice(startOffset).split("\n");
  let endLines = 1;
  for (let i = 1; i < after.length; i++) {
    const line = after[i];
    if (/^\S/.test(line) && /^(def|class)\s+/.test(line)) break;
    if (i > 1 && /^\S/.test(line) && line.trim()) break;
    endLines++;
  }
  const lines = content.slice(0, startOffset).split("\n").length;
  let endOffset = startOffset;
  const all = content.split("\n");
  for (let i = lines - 1; i < Math.min(all.length, lines - 1 + endLines); i++) endOffset += all[i].length + 1;
  return { startOffset, endOffset: Math.min(content.length, endOffset) };
}

export function codeAdapterFactory(): FileAdapterFactory {
  return {
    id: "core.code.factory",
    canHandle(snapshot: FileSnapshot) {
      return snapshot.exists && !snapshot.isBinary && CODE_EXTENSIONS.has(ext(snapshot.path));
    },
    create() {
      const adapter: FileAdapter = {
        id: "core.code",
        kind: "code",
        priority: 30,
        capabilities: ["read", "search", "resolve", "validate", "symbols"],
        parse({ snapshot }) {
          return { ok: true, diagnostics: [], symbols: findCodeSymbols(snapshot.content ?? "") };
        },
        search({ snapshot, query, maxResults, caseSensitive }) {
          const q = isTrue(caseSensitive) ? query : query.toLowerCase();
          const symbols = findCodeSymbols(snapshot.content ?? "").filter((s) => {
            const name = isTrue(caseSensitive) ? s.name : s.name.toLowerCase();
            return name.includes(q);
          });
          return symbols.slice(0, maxResults ?? 20).map((s) => ({ path: snapshot.path, score: 2, kind: "symbol", range: s.range, snippet: s.name, adapterId: "core.code" }));
        },
        resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): ResolveTargetResult {
          const symbol = input.target?.symbol;
          if (!symbol) return { status: "not_found", reason: "code adapter 未收到 symbol target" };
          const content = input.snapshot.content ?? "";
          const symbols = findCodeSymbols(content).filter((s) => s.name === symbol.name && (!symbol.kind || s.kind === symbol.kind));
          if (isEmpty(symbols)) return { status: "not_found", reason: `未找到符号：${symbol.name}` };
          const candidates: ResolvedTarget[] = symbols.map((s) => {
            const expanded = expandCodeBlock(content, s.range.startOffset ?? 0);
            const exactSnippet = content.slice(expanded.startOffset, expanded.endOffset);
            return {
              targetId: id("target"),
              path: input.snapshot.path,
              baseRevision: input.snapshot.revision,
              sha256: input.snapshot.sha256,
              kind: "symbol",
              range: rangeFromOffsets(content, expanded.startOffset, expanded.endOffset),
              symbol: { kind: s.kind, name: s.name, container: symbol.container, signatureHash: s.signatureHash },
              anchors: { exactSnippet, startSnippet: exactSnippet.slice(0, 120), endSnippet: exactSnippet.slice(-120), mustContain: input.target?.anchors?.mustContain },
              confidence: 0.8,
              expectedMatches: input.expectedMatches ?? 1,
              adapterId: "core.code",
            };
          });
          if (candidates.length === 1) return { status: "resolved", target: candidates[0] };
          return { status: "ambiguous", candidates, reason: `找到 ${candidates.length} 个名为 ${symbol.name} 的符号` };
        },
      };
      return adapter;
    },
  };
}
