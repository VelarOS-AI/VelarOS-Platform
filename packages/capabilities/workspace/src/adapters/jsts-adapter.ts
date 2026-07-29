import * as ts from 'typescript'

import { isEmpty,isPresent, isTrue } from '@velaros-ai/core'

import type { FileAdapter, FileAdapterFactory, SymbolInfo } from '../types/adapter.js'
import type { FileSnapshot } from '../types/snapshot.js'
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from '../types/target.js'
import { id } from '../utils/id.js'
import { ext } from '../utils/path.js'
import { rangeFromOffsets } from '../utils/text.js'

const JSTS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'])

function findBraceEnd(content: string, open: number): number {
  let depth = 0
  let quote: string | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = open; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]
    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i++
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = undefined
      }
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return content.length
}

function findDeclarationEnd(content: string, start: number): number {
  const open = content.indexOf('{', start)
  if (open !== -1 && open - start < 500) return findBraceEnd(content, open)
  const lineEnd = content.indexOf('\n', start)
  return lineEnd === -1 ? content.length : lineEnd
}

function signatureHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i)
  return `sig_${(h >>> 0).toString(16)}`
}

function addSymbol(
  symbols: SymbolInfo[],
  content: string,
  kind: string,
  name: string,
  start: number,
  end: number,
  container?: string,
  exported = false
): void {
  const source = content.slice(start, end)
  symbols.push({
    kind,
    name,
    container,
    exported,
    range: rangeFromOffsets(content, start, end),
    signatureHash: signatureHash(source),
    metadata: { length: end - start, exported },
  })
}

export function findJsTsSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  const classRanges: Array<{ name: string; start: number; end: number }> = []

  // ── 类声明 ───────────────────────────────────────────────────────────────
  const classRegex =
    /(?:export\s+default\s+|export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/g
  let match: Nullable<RegExpExecArray>
  while ((match = classRegex.exec(content))) {
    const start = match.index
    const end = findDeclarationEnd(content, start)
    classRanges.push({ name: match[1], start, end })
    addSymbol(
      symbols,
      content,
      'class',
      match[1],
      start,
      end,
      undefined,
      /\bexport\b/.test(match[0])
    )
  }

  // ── 函数、箭头函数和函数表达式 ───────────────────────────────────────────
  const fnPatterns: Array<{ kind: string; regex: RegExp }> = [
    {
      kind: 'function',
      regex: /(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    },
    {
      kind: 'function',
      regex:
        /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    },
    {
      kind: 'function',
      regex:
        /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(/g,
    },
  ]

  for (const { kind, regex } of fnPatterns) {
    while ((match = regex.exec(content))) {
      const start = match.index
      const end = findDeclarationEnd(content, start)
      const enclosing = classRanges.find((c) => start > c.start && start < c.end)?.name
      addSymbol(
        symbols,
        content,
        kind,
        match[1],
        start,
        end,
        enclosing,
        /\bexport\b/.test(match[0])
      )
    }
  }

  // ── TypeScript 专属：interface、type alias、enum、namespace ─────────────
  const tsPatterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: 'interface', regex: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/g },
    { kind: 'type', regex: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/g },
    { kind: 'enum', regex: /(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/g },
    { kind: 'namespace', regex: /(?:export\s+)?namespace\s+([A-Za-z_$][\w$]*)\b/g },
  ]

  for (const { kind, regex } of tsPatterns) {
    while ((match = regex.exec(content))) {
      const start = match.index
      const end = findDeclarationEnd(content, start)
      addSymbol(
        symbols,
        content,
        kind,
        match[1],
        start,
        end,
        undefined,
        /\bexport\b/.test(match[0])
      )
    }
  }

  // ── 类方法 ───────────────────────────────────────────────────────────────
  for (const cls of classRanges) {
    const bodyStart = content.indexOf('{', cls.start)
    if (bodyStart < 0) continue
    const body = content.slice(bodyStart + 1, cls.end - 1)
    const methodRegex =
      /(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^{}]+)?\s*\{/g
    while ((match = methodRegex.exec(body))) {
      const name = match[1]
      if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name)) continue
      const start = bodyStart + 1 + match.index
      const open = content.indexOf('{', start)
      const end = open >= 0 ? findBraceEnd(content, open) : findDeclarationEnd(content, start)
      addSymbol(symbols, content, 'method', name, start, end, cls.name)
    }
  }

  // 去重：name+start 相同的符号保留第一次出现的结果。
  const seen = new Set<string>()
  const deduped: SymbolInfo[] = []
  for (const s of symbols.sort((a, b) => (a.range.startOffset ?? 0) - (b.range.startOffset ?? 0))) {
    const key = `${s.name}:${s.range.startOffset}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(s)
    }
  }
  return deduped
}

function makeTarget(snapshot: FileSnapshot, symbol: SymbolInfo, confidence = 0.98): ResolvedTarget {
  const content = snapshot.content ?? ''
  const start = symbol.range.startOffset ?? 0
  const end = symbol.range.endOffset ?? start
  const exactSnippet = content.slice(start, end)
  return {
    targetId: id('target'),
    path: snapshot.path,
    baseRevision: snapshot.revision,
    sha256: snapshot.sha256,
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
      startSnippet: exactSnippet.slice(0, 120),
      endSnippet: exactSnippet.slice(-120),
      mustContain: [symbol.name],
    },
    confidence,
    expectedMatches: 1,
    adapterId: 'jsts.adapter',
  }
}

async function syntaxDiagnostics(
  snapshot: FileSnapshot
): Promise<
  Array<{
    severity: 'error' | 'warning'
    message: string
    path?: string
    source?: string
    line?: number
  }>
> {
  const source = snapshot.content ?? ''
  try {
    const extname = ext(snapshot.path)
    const scriptKind =
      extname === '.tsx'
        ? ts.ScriptKind.TSX
        : extname === '.jsx'
          ? ts.ScriptKind.JSX
          : extname.includes('ts')
            ? ts.ScriptKind.TS
            : ts.ScriptKind.JS
    const file = ts.createSourceFile(
      snapshot.path,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    )
    const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    return diagnostics.map((d: any) => {
      const pos = isPresent(d.start) ? file.getLineAndCharacterOfPosition(d.start) : undefined
      return {
        severity: 'error' as const,
        message: `JS/TS 语法错误：${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
        path: snapshot.path,
        source: 'jsts.typescript-parser',
        line: isPresent(pos) ? pos.line + 1 : undefined,
      }
    })
  } catch {
    // arch-guard:silent-catch-ok 可选依赖不可用时回退到轻量括号平衡检查。
    const stack: string[] = []
    const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]
      if ('{(['.includes(ch)) stack.push(ch)
      if ('})]'.includes(ch) && stack.pop() !== pairs[ch]) return [
          {
            severity: 'error',
            message: `offset ${i} 附近存在未配平的 token`,
            path: snapshot.path,
            source: 'jsts.fallback-parser',
          },
        ]
    }
    if (!isEmpty(stack))
      return [
        {
          severity: 'error',
          message: '花括号、圆括号或方括号未配平',
          path: snapshot.path,
          source: 'jsts.fallback-parser',
        },
      ]
    return []
  }
}

export function jsTsAdapterFactory(): FileAdapterFactory {
  return {
    id: 'jsts.factory',
    canHandle(snapshot: FileSnapshot) {
      return snapshot.exists && !snapshot.isBinary && JSTS_EXTENSIONS.has(ext(snapshot.path))
    },
    create() {
      const adapter: FileAdapter = {
        id: 'jsts.adapter',
        kind: 'code',
        priority: 80,
        capabilities: ['read', 'search', 'resolve', 'validate', 'symbols', 'prepare_edit'],
        parse({ snapshot }) {
          return { ok: true, diagnostics: [], symbols: findJsTsSymbols(snapshot.content ?? '') }
        },
        search({ snapshot, query, maxResults, caseSensitive }) {
          const q = isTrue(caseSensitive) ? query : query.toLowerCase()
          return findJsTsSymbols(snapshot.content ?? '')
            .filter((s) => {
              const name = isTrue(caseSensitive) ? s.name : s.name.toLowerCase()
              const container = isTrue(caseSensitive) ? s.container : s.container?.toLowerCase()
              return name.includes(q) || container?.includes(q)
            })
            .slice(0, maxResults ?? 20)
            .map((s) => ({
              path: snapshot.path,
              score: s.container ? 4 : 3,
              kind: 'symbol' as const,
              range: s.range,
              snippet: `${s.container ? `${s.container}.` : ''}${s.name}`,
              adapterId: 'jsts.adapter',
            }))
        },
        resolveTarget(input: ResolveTargetInput & { snapshot: FileSnapshot }): ResolveTargetResult {
          const wanted = input.target?.symbol
          if (!wanted?.name)
            return { status: 'not_found', reason: 'jsts adapter 需要 symbol name' }
          let matches = findJsTsSymbols(input.snapshot.content ?? '').filter(
            (s) => s.name === wanted.name
          )
          if (wanted.kind)
            matches = matches.filter(
              (s) => s.kind === wanted.kind || (wanted.kind === 'function' && s.kind === 'method')
            )
          if (wanted.container) matches = matches.filter((s) => s.container === wanted.container)
          if (isEmpty(matches))
            return {
              status: 'not_found',
              reason: `未找到符号：${wanted.container ? `${wanted.container}.` : ''}${wanted.name}`,
            }
          if (matches.length > 1)
            return {
              status: 'ambiguous',
              reason: `找到多个名为 ${wanted.name} 的符号`,
              candidates: matches.map((s) => makeTarget(input.snapshot, s, 0.82)),
            }
          return { status: 'resolved', target: makeTarget(input.snapshot, matches[0]) }
        },
        async validate({ snapshot, changedContent }) {
          const diagnostics = await syntaxDiagnostics({
            ...snapshot,
            content: changedContent ?? snapshot.content,
          })
          return {
            ok: diagnostics.length === 0,
            diagnostics,
            checks: [{ id: 'jsts.syntax', ok: diagnostics.length === 0, diagnostics }],
          }
        },
      }
      return adapter
    },
  }
}

export const __privateJsTs = { findJsTsSymbols, findBraceEnd }
