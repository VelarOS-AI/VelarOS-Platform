/**
 * 通用代码 adapter：`CodeFileAdapter`，实现注入面的 `FileAdapter`（contract/requires.ts）。
 * 给 Python、Go、Rust、Java 等非 JS/TS 源码按正则认函数与类，提供符号搜索与按符号解析目标；块范围按花括号或缩进推断。
 */

import { isEmpty, isTrue } from '@velaros-ai/core'

import type { FileAdapter } from '../../contract/requires.js'
import type {
  AdapterCapability,
  AdapterKind,
  AdapterSearchHit,
  AdapterSearchInput,
  ParseInput,
  ParseResult,
} from '../../types/adapter.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import type { ResolvedTarget, ResolveTargetInput, ResolveTargetResult } from '../../types/target.js'
import { expandCodeBlock, findCodeSymbols } from '../../utils/code-symbols.js'
import { id } from '../../utils/id.js'
import { rangeFromOffsets } from '../../utils/text.js'
import { ProjectTuning } from '../../utils/tuning.js'

export class CodeFileAdapter implements FileAdapter {
  public readonly id = 'core.code'
  public readonly kind: AdapterKind = 'code'
  public readonly priority = 30
  public readonly capabilities: AdapterCapability[] = [
    'read',
    'search',
    'resolve',
    'validate',
    'symbols',
  ]

  public parse(input: ParseInput): ParseResult {
    return { ok: true, diagnostics: [], symbols: findCodeSymbols(input.snapshot.content ?? '') }
  }

  public search(input: AdapterSearchInput): AdapterSearchHit[] {
    const { snapshot, query, maxResults, caseSensitive } = input
    const q = isTrue(caseSensitive) ? query : query.toLowerCase()
    const symbols = findCodeSymbols(snapshot.content ?? '').filter((s) => {
      const name = isTrue(caseSensitive) ? s.name : s.name.toLowerCase()
      return name.includes(q)
    })
    return symbols.slice(0, maxResults ?? ProjectTuning.adapters.codeSymbolHits).map((s) => ({
      path: snapshot.path,
      score: 2,
      kind: 'symbol',
      range: s.range,
      snippet: s.name,
      adapterId: this.id,
    }))
  }

  public resolveTarget(
    input: ResolveTargetInput & { snapshot: FileSnapshot }
  ): ResolveTargetResult {
    const symbol = input.target?.symbol
    if (!symbol) return { status: 'not_found', reason: 'code adapter 未收到 symbol target' }
    const content = input.snapshot.content ?? ''
    const symbols = findCodeSymbols(content).filter(
      (s) => s.name === symbol.name && (!symbol.kind || s.kind === symbol.kind)
    )
    if (isEmpty(symbols)) return { status: 'not_found', reason: `未找到符号：${symbol.name}` }
    const candidates: ResolvedTarget[] = symbols.map((s) => {
      const expanded = expandCodeBlock(content, s.range.startOffset ?? 0)
      const exactSnippet = content.slice(expanded.startOffset, expanded.endOffset)
      return {
        targetId: id('target'),
        path: input.snapshot.path,
        baseRevision: input.snapshot.revision,
        sha256: input.snapshot.sha256,
        kind: 'symbol',
        range: rangeFromOffsets(content, expanded.startOffset, expanded.endOffset),
        symbol: {
          kind: s.kind,
          name: s.name,
          container: symbol.container,
          signatureHash: s.signatureHash,
        },
        anchors: {
          exactSnippet,
          startSnippet: exactSnippet.slice(0, 120),
          endSnippet: exactSnippet.slice(-120),
          mustContain: input.target?.anchors?.mustContain,
        },
        confidence: 0.8,
        expectedMatches: input.expectedMatches ?? 1,
        adapterId: this.id,
      }
    })
    if (candidates.length === 1) return { status: 'resolved', target: candidates[0] }
    return {
      status: 'ambiguous',
      candidates,
      reason: `找到 ${candidates.length} 个名为 ${symbol.name} 的符号`,
    }
  }
}
