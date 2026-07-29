import { isEmpty,isTrue } from "@velaros-ai/core";

import type { FileAdapter, FileAdapterFactory } from "../../types/adapter.js";
import type { FileSnapshot } from "../../types/snapshot.js";
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from "../../types/target.js";
import { id } from "../../utils/id.js";
import { ext } from "../../utils/path.js";

import { parseTs } from "./ast.js";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function toTarget(snapshot: FileSnapshot, input: ResolveTargetInput, symbol: ReturnType<typeof parseTs>["symbols"][number]): ResolvedTarget {
  const content = snapshot.content ?? "";
  const exactSnippet = content.slice(symbol.range.startOffset ?? 0, symbol.range.endOffset ?? 0);
  return {
    targetId: id("target"),
    path: snapshot.path,
    baseRevision: snapshot.revision,
    sha256: snapshot.sha256,
    kind: "symbol",
    range: symbol.range,
    symbol: {
      kind: symbol.kind,
      name: symbol.name,
      container: symbol.container,
      signatureHash: symbol.signatureHash,
    },
    anchors: {
      exactSnippet,
      startSnippet: exactSnippet.slice(0, 160),
      endSnippet: exactSnippet.slice(-160),
      mustContain: input.target?.anchors?.mustContain,
    },
    confidence: 0.97,
    expectedMatches: input.expectedMatches ?? 1,
    adapterId: "velaros.typescript.ast",
    metadata: {
      nodeKind: symbol.nodeKind,
      bodyRange: symbol.bodyRange,
    },
  };
}

export function typescriptAdapterFactory(): FileAdapterFactory {
  return {
    id: "velaros.typescript.factory",
    canHandle(snapshot: FileSnapshot) {
      return snapshot.exists && !snapshot.isDirectory && !snapshot.isBinary && TS_EXTENSIONS.has(ext(snapshot.path));
    },
    create() {
      const adapter: FileAdapter = {
        id: "velaros.typescript.ast",
        kind: "code",
        priority: 100,
        capabilities: ["read", "search", "resolve", "validate", "symbols"],
        parse({ snapshot }) {
          const parsed = parseTs(snapshot.path, snapshot.content ?? "");
          return {
            ok: isEmpty(parsed.diagnostics),
            diagnostics: parsed.diagnostics.map((diagnostic) => ({
              severity: "error",
              message: `TypeScript AST 解析错误：${String(diagnostic.messageText)}`,
              source: "typescript-ast",
              data: { code: diagnostic.code },
            })),
            ast: { kind: "typescript.SourceFile", fileName: parsed.sourceFile.fileName },
            symbols: parsed.symbols,
          };
        },
        search({ snapshot, query, maxResults, caseSensitive }) {
          const parsed = parseTs(snapshot.path, snapshot.content ?? "");
          const caseInsensitive = !isTrue(caseSensitive);
          const ql = caseInsensitive ? query.toLowerCase() : query;
          return parsed.symbols
            .filter((symbol) => {
              const name = caseInsensitive ? symbol.name.toLowerCase() : symbol.name;
              const kind = caseInsensitive ? symbol.kind.toLowerCase() : symbol.kind;
              const container = symbol.container ?? "";
              const c = caseInsensitive ? container.toLowerCase() : container;
              return name.includes(ql) || kind.includes(ql) || c.includes(ql);
            })
            .slice(0, maxResults ?? 50)
            .map((symbol) => {
              const exact =
                caseInsensitive
                  ? symbol.name.toLowerCase() === query.toLowerCase()
                  : symbol.name === query;
              const partial =
                caseInsensitive
                  ? symbol.name.toLowerCase().includes(query.toLowerCase())
                  : symbol.name.includes(query);
              return {
                path: snapshot.path,
                score: exact ? 5 : partial ? 4 : 2,
                kind: "symbol" as const,
                range: symbol.range,
                snippet: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name,
                adapterId: "velaros.typescript.ast",
              };
            });
        },
        resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): ResolveTargetResult {
          if (input.baseRevision && input.baseRevision !== input.snapshot.revision) return { status: "not_found", reason: `baseRevision 不匹配：${input.baseRevision} != ${input.snapshot.revision}` };
          const requested = input.target?.symbol;
          if (!requested) return { status: "not_found", reason: "TypeScript AST resolver 需要 symbol target" };
          const parsed = parseTs(input.snapshot.path, input.snapshot.content ?? "");
          const symbols = parsed.symbols.filter((symbol) => {
            if (requested.name !== symbol.name) return false;
            if (requested.kind && requested.kind !== "unknown" && requested.kind !== symbol.kind) return false;
            if (requested.container && requested.container !== symbol.container) return false;
            return true;
          });
          if (isEmpty(symbols)) return { status: "not_found", reason: `未找到符号：${requested.container ? `${requested.container}.` : ""}${requested.name}` };
          const targets = symbols.map((symbol) => toTarget(input.snapshot, input, symbol));
          if (targets.length === 1) return { status: "resolved", target: targets[0] };
          return { status: "ambiguous", candidates: targets, reason: `找到 ${targets.length} 个名为 ${requested.name} 的 JS/TS 符号` };
        },
        validate({ snapshot }) {
          const parsed = parseTs(snapshot.path, snapshot.content ?? "");
          const diagnostics = parsed.diagnostics.map((diagnostic) => ({
            severity: "error" as const,
            message: `TypeScript AST 校验错误：${String(diagnostic.messageText)}`,
            source: "typescript-ast",
            data: { code: diagnostic.code },
          }));
          return { ok: isEmpty(diagnostics), diagnostics, checks: [{ id: "typescript.syntax", ok: isEmpty(diagnostics), diagnostics }] };
        },
      };
      return adapter;
    },
  };
}
