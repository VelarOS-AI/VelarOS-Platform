import { isEmpty, isTrue } from '@velaros-ai/core'

import type { FileAdapter, FileAdapterFactory } from '../types/adapter.js'
import type { FileSnapshot } from '../types/snapshot.js'
import type { ResolvedTarget, ResolveTargetInput, ResolveTargetResult } from '../types/target.js'
import { id } from '../utils/id.js'

import { isJsTsPath, type JsTsSymbol, jsTsSyntaxDiagnostics, parseJsTs, selectJsTsSymbols } from './jsts-ast.js'

/** 同一实现以不同身份注册：核心 adapter 与 TypeScript 插件 adapter 只差 id、优先级与检查项名。 */
export interface JsTsAdapterIdentity {
  factoryId: string
  adapterId: string
  priority: number
  checkId: string
}

export function jsTsAdapterFactory(): FileAdapterFactory {
  return createJsTsAdapterFactory({
    factoryId: 'jsts.factory',
    adapterId: 'jsts.adapter',
    priority: 80,
    checkId: 'jsts.syntax',
  })
}

export function createJsTsAdapterFactory(identity: JsTsAdapterIdentity): FileAdapterFactory {
  return {
    id: identity.factoryId,
    canHandle(snapshot: FileSnapshot) {
      return snapshot.exists && !snapshot.isDirectory && !snapshot.isBinary && isJsTsPath(snapshot.path)
    },
    create() {
      const adapter: FileAdapter = {
        id: identity.adapterId,
        kind: 'code',
        priority: identity.priority,
        capabilities: ['read', 'search', 'resolve', 'validate', 'symbols'],
        parse({ snapshot }) {
          const content = snapshot.content ?? ''
          const parsed = parseJsTs(snapshot.path, content)
          return {
            ok: isEmpty(parsed.diagnostics),
            diagnostics: jsTsSyntaxDiagnostics(snapshot.path, content, identity.adapterId),
            ast: { kind: 'typescript.SourceFile', fileName: parsed.sourceFile.fileName },
            symbols: parsed.symbols,
          }
        },
        search({ snapshot, query, maxResults, caseSensitive }) {
          const fold = (text: string) => (isTrue(caseSensitive) ? text : text.toLowerCase())
          const needle = fold(query)
          return parseJsTs(snapshot.path, snapshot.content ?? '')
            .symbols.filter((symbol) =>
              [symbol.name, symbol.container ?? ''].some((field) => fold(field).includes(needle))
            )
            .slice(0, maxResults ?? 50)
            .map((symbol) => {
              const name = fold(symbol.name)
              return {
                path: snapshot.path,
                score: name === needle ? 5 : name.includes(needle) ? 4 : 2,
                kind: 'symbol' as const,
                range: symbol.range,
                snippet: qualifiedName(symbol),
                adapterId: identity.adapterId,
              }
            })
        },
        resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): ResolveTargetResult {
          if (input.baseRevision && input.baseRevision !== input.snapshot.revision) return { status: 'not_found', reason: `baseRevision 不匹配：${input.baseRevision} != ${input.snapshot.revision}` }
          const wanted = input.target?.symbol
          if (!wanted?.name) return { status: 'not_found', reason: `${identity.adapterId} 需要 symbol name` }
          const matches = selectJsTsSymbols(parseJsTs(input.snapshot.path, input.snapshot.content ?? '').symbols, wanted)
          if (isEmpty(matches)) return { status: 'not_found', reason: `未找到符号：${wanted.container ? `${wanted.container}.` : ''}${wanted.name}` }
          if (matches.length > 1) return {
              status: 'ambiguous',
              reason: `找到 ${matches.length} 个名为 ${wanted.name} 的 JS/TS 符号`,
              candidates: matches.map((symbol) => toTarget(input, symbol, 0.82, identity.adapterId)),
            }
          return { status: 'resolved', target: toTarget(input, matches[0], 0.98, identity.adapterId) }
        },
        validate({ snapshot, changedContent }) {
          const diagnostics = jsTsSyntaxDiagnostics(snapshot.path, changedContent ?? snapshot.content ?? '', identity.adapterId)
          const ok = isEmpty(diagnostics)
          return { ok, diagnostics, checks: [{ id: identity.checkId, ok, diagnostics }] }
        },
      }
      return adapter
    },
  }
}

function toTarget(
  input: ResolveTargetInput & { snapshot: FileSnapshot },
  symbol: JsTsSymbol,
  confidence: number,
  adapterId: string
): ResolvedTarget {
  const exactSnippet = (input.snapshot.content ?? '').slice(symbol.range.startOffset, symbol.range.endOffset)
  return {
    targetId: id('target'),
    path: input.snapshot.path,
    baseRevision: input.snapshot.revision,
    sha256: input.snapshot.sha256,
    kind: 'symbol',
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
      mustContain: input.target?.anchors?.mustContain ?? [symbol.name],
    },
    confidence,
    expectedMatches: input.expectedMatches ?? 1,
    adapterId,
  }
}

function qualifiedName(symbol: JsTsSymbol): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name
}
