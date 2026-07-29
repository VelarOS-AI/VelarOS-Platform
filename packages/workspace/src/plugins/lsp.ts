import { isEmpty } from '@velaros-ai/core'

import { WORKSPACE_PACKAGE_VERSION } from "../core/defaults.js";
import type { FileAdapter, FileAdapterFactory, SymbolInfo } from "../types/adapter.js";
import type { Diagnostic } from "../types/common.js";
import type { WorkspacePlugin } from "../types/plugin.js";
import type { FileSnapshot } from "../types/snapshot.js";
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from "../types/target.js";
import { id } from "../utils/id.js";
import { rangeFromOffsets } from "../utils/text.js";

export interface LspSymbol {
  kind: string;
  name: string;
  container?: string;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, any>;
}

export interface LspProvider {
  id?: string;
  canHandle?(input: { path: string }): boolean | Promise<boolean>;
  listSymbols?(input: { path: string; content: string }): Promise<LspSymbol[]> | LspSymbol[];
  diagnostics?(input: { path: string; content: string }): Promise<Diagnostic[]> | Diagnostic[];
  findReferences?(input: { path: string; symbol: string }): Promise<any[]> | any[];
}

export interface LspPluginOptions {
  provider: LspProvider;
}

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
    symbol: { kind: symbol.kind, name: symbol.name, container: symbol.container },
    anchors: { exactSnippet, startSnippet: exactSnippet.slice(0, 100), endSnippet: exactSnippet.slice(-100), mustContain: [symbol.name] },
    confidence: 0.99,
    expectedMatches: 1,
    adapterId,
  };
}

export function lspAdapterFactory(options: LspPluginOptions): FileAdapterFactory {
  const adapterId = `lsp.${options.provider.id ?? "provider"}`;
  return {
    id: `${adapterId}.factory`,
    async canHandle(snapshot: FileSnapshot) {
      if (!snapshot.exists || snapshot.isBinary) return false;
      return options.provider.canHandle ? options.provider.canHandle({ path: snapshot.path }) : true;
    },
    create() {
      const adapter: FileAdapter = {
        id: adapterId,
        kind: "code",
        priority: 110,
        capabilities: ["symbols", "resolve", "validate"],
        async parse({ snapshot }) {
          const raw = (await options.provider.listSymbols?.({ path: snapshot.path, content: snapshot.content ?? "" })) ?? [];
          const symbols: SymbolInfo[] = raw.map((s) => ({ kind: s.kind, name: s.name, container: s.container, range: rangeFromOffsets(snapshot.content ?? "", s.startOffset, s.endOffset), metadata: s.metadata }));
          return { ok: true, diagnostics: [], symbols };
        },
        async resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): Promise<ResolveTargetResult> {
          const wanted = input.target?.symbol;
          if (!wanted?.name) return { status: "not_found", reason: "LSP target 需要 symbol name" };
          const parsed = await adapter.parse!({ snapshot: input.snapshot });
          let matches = (parsed.symbols ?? []).filter((s) => s.name === wanted.name);
          if (wanted.kind) matches = matches.filter((s) => s.kind === wanted.kind || (wanted.kind === "function" && s.kind === "method"));
          if (wanted.container) matches = matches.filter((s) => s.container === wanted.container);
          if (isEmpty(matches)) return { status: "not_found", reason: `未找到符号：${wanted.name}` };
          if (matches.length > 1) return { status: "ambiguous", reason: `找到多个名为 ${wanted.name} 的符号`, candidates: matches.map((s) => targetFromSymbol(input.snapshot, s, adapterId)) };
          return { status: "resolved", target: targetFromSymbol(input.snapshot, matches[0], adapterId) };
        },
        async validate({ snapshot }) {
          const diagnostics = await options.provider.diagnostics?.({ path: snapshot.path, content: snapshot.content ?? "" }) ?? [];
          return { ok: diagnostics.every((d) => d.severity !== "error"), diagnostics, checks: [{ id: adapterId, ok: diagnostics.every((d) => d.severity !== "error"), diagnostics }] };
        },
      };
      return adapter;
    },
  };
}

export function lspPlugin(options: LspPluginOptions): WorkspacePlugin {
  return {
    name: "@velaros-ai/workspace/lsp",
    version: WORKSPACE_PACKAGE_VERSION,
    setup(ctx) {
      ctx.registerAdapterFactory(lspAdapterFactory(options));
    },
  };
}
