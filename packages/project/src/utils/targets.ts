// 域：adapter 解析出的目标。把原文区间或 AST 符号做成绑定 revision、带复核锚点的 ResolvedTarget，
// 后面准备编辑时按 revision 与锚点确认目标没有漂移。
import type { JsTsSymbol } from '../types/jsts.js'
import type { FileSnapshot } from '../types/snapshot.js'
import type { ResolvedTarget, ResolveTargetInput } from '../types/target.js'

import { id } from './id.js'
import { rangeFromOffsets } from './text.js'

/** 用原始 offset 构造绑定 revision 的目标，同时保留文本锚点供后续复核。 */
export function textRangeTarget(
  snapshot: FileSnapshot,
  range: { startOffset: number; endOffset: number },
  input: ResolveTargetInput,
  confidence: number,
  adapterId: string,
): ResolvedTarget {
  const exactSnippet = snapshot.content?.slice(range.startOffset, range.endOffset)
  const symbol = input.target?.symbol
  return {
    targetId: id('target'),
    path: snapshot.path,
    baseRevision: snapshot.revision,
    sha256: snapshot.sha256,
    kind: symbol ? 'symbol' : 'range',
    range: rangeFromOffsets(snapshot.content ?? '', range.startOffset, range.endOffset),
    symbol: symbol
      ? {
          kind: symbol.kind ?? 'unknown',
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
  }
}

/** 用 AST 符号的范围构造目标；没给 mustContain 时要求目标里含符号名。 */
export function jsTsSymbolTarget(
  input: ResolveTargetInput & { snapshot: FileSnapshot },
  symbol: JsTsSymbol,
  confidence: number,
  adapterId: string,
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

/** 带容器的符号名：`Container.name`，没有容器时只是 name。 */
export function qualifiedSymbolName(symbol: JsTsSymbol): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name
}
