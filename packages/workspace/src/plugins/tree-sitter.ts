import { isEmpty,isTrue } from "@velaros-ai/core";

import { WORKSPACE_PACKAGE_VERSION } from "../core/defaults.js";
import type { FileAdapter, FileAdapterFactory, SymbolInfo } from "../types/adapter.js";
import type { WorkspacePlugin } from "../types/plugin.js";
import type { FileSnapshot } from "../types/snapshot.js";
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from "../types/target.js";
import { id } from "../utils/id.js";
import { ext } from "../utils/path.js";
import { rangeFromOffsets } from "../utils/text.js";

export interface TreeSitterSymbol {
  kind: string;
  name: string;
  container?: string;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, any>;
}

export interface TreeSitterProvider {
  id?: string;
  canParse?(input: { path: string; language?: string; extension: string }): boolean | Promise<boolean>;
  listSymbols(input: { path: string; content: string; language?: string; extension: string }): Promise<TreeSitterSymbol[]> | TreeSitterSymbol[];
  parse?(input: { path: string; content: string; language?: string; extension: string }): Promise<any> | any;
}

export interface TreeSitterPluginOptions {
  provider?: TreeSitterProvider;
  extensions?: string[];
}

const DEFAULT_CODE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp"];

function targetFromSymbol(snapshot: FileSnapshot, symbol: SymbolInfo, adapterId: string): ResolvedTarget {
  const content = snapshot.content ?? "";
  const start = symbol.range.startOffset ?? 0;
  const end = symbol.range.endOffset ?? start;
  const exactSnippet = content.slice(start, end);
  return {
    targetId: id("target"),
    path: snapshot.path,
    baseRevision: snapshot.revision,
    sha256: snapshot.sha256,
    kind: "symbol",
    range: symbol.range,
    symbol: { kind: symbol.kind, name: symbol.name, container: symbol.container, signatureHash: symbol.signatureHash },
    anchors: { exactSnippet, startSnippet: exactSnippet.slice(0, 100), endSnippet: exactSnippet.slice(-100), mustContain: [symbol.name] },
    confidence: 0.99,
    expectedMatches: 1,
    adapterId,
  };
}

export function treeSitterAdapterFactory(options: TreeSitterPluginOptions): FileAdapterFactory {
  const adapterId = `treesitter.${options.provider?.id ?? "provider"}`;
  const extensions = new Set(options.extensions ?? DEFAULT_CODE_EXTENSIONS);
  return {
    id: `${adapterId}.factory`,
    async canHandle(snapshot: FileSnapshot) {
      if (!options.provider || !snapshot.exists || snapshot.isBinary || !extensions.has(ext(snapshot.path))) return false;
      if (options.provider.canParse) return options.provider.canParse({ path: snapshot.path, extension: ext(snapshot.path) });
      return true;
    },
    create() {
      const adapter: FileAdapter = {
        id: adapterId,
        kind: "code",
        priority: 100,
        capabilities: ["read", "search", "resolve", "symbols", "validate"],
        async parse({ snapshot }) {
          if (!options.provider) return { ok: false, diagnostics: [{ severity: "warning", message: "未配置 Tree-sitter provider", source: adapterId }] };
          const symbolsRaw = await options.provider.listSymbols({ path: snapshot.path, content: snapshot.content ?? "", extension: ext(snapshot.path) });
          const symbols: SymbolInfo[] = symbolsRaw.map((s) => ({ kind: s.kind, name: s.name, container: s.container, range: rangeFromOffsets(snapshot.content ?? "", s.startOffset, s.endOffset), metadata: s.metadata }));
          const ast = await options.provider.parse?.({ path: snapshot.path, content: snapshot.content ?? "", extension: ext(snapshot.path) });
          return { ok: true, symbols, ast, diagnostics: [] };
        },
        async search({ snapshot, query, maxResults, caseSensitive }) {
          const parsed = await adapter.parse!({ snapshot });
          const caseInsensitive = !isTrue(caseSensitive);
          const ql = caseInsensitive ? query.toLowerCase() : query;
          return (parsed.symbols ?? [])
            .filter((s) => {
              const name = caseInsensitive ? s.name.toLowerCase() : s.name;
              const container = s.container ?? "";
              const c = caseInsensitive ? container.toLowerCase() : container;
              return name.includes(ql) || c.includes(ql);
            })
            .slice(0, maxResults ?? 20)
            .map((s) => ({ path: snapshot.path, score: 5, kind: "symbol" as const, range: s.range, snippet: `${s.container ? `${s.container}.` : ""}${s.name}`, adapterId }));
        },
        async resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): Promise<ResolveTargetResult> {
          const wanted = input.target?.symbol;
          if (!wanted?.name) return { status: "not_found", reason: "Tree-sitter target 需要 symbol name" };
          const parsed = await adapter.parse!({ snapshot: input.snapshot });
          let matches = (parsed.symbols ?? []).filter((s) => s.name === wanted.name);
          if (wanted.kind) matches = matches.filter((s) => s.kind === wanted.kind || (wanted.kind === "function" && s.kind === "method"));
          if (wanted.container) matches = matches.filter((s) => s.container === wanted.container);
          if (isEmpty(matches)) return { status: "not_found", reason: `未找到符号：${wanted.name}` };
          if (matches.length > 1) return { status: "ambiguous", reason: `找到多个名为 ${wanted.name} 的符号`, candidates: matches.map((s) => targetFromSymbol(input.snapshot, s, adapterId)) };
          return { status: "resolved", target: targetFromSymbol(input.snapshot, matches[0], adapterId) };
        },
      };
      return adapter;
    },
  };
}

export function treeSitterPlugin(options: TreeSitterPluginOptions = {}): WorkspacePlugin {
  return {
    name: "@velaros-ai/workspace/tree-sitter",
    version: WORKSPACE_PACKAGE_VERSION,
    setup(ctx) {
      if (options.provider) ctx.registerAdapterFactory(treeSitterAdapterFactory(options));
    },
  };
}
