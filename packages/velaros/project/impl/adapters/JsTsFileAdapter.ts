/**
 * JS/TS adapter：`JsTsFileAdapter`，实现注入面的 `FileAdapter`（contract/requires.ts）。
 * 符号、语法诊断与目标范围都出自同一棵 TypeScript AST（utils/jsts-ast.ts）。同一实现以两种身份注册：
 * 核心插件的 jsts.adapter，TypeScript 插件以更高优先级再注册一份，只差 id、优先级与检查项名。
 */

import { isEmpty, isTrue } from '@velaros-ai/core'

import type { FileAdapter } from '../../contract/requires.js'
import type {
  AdapterCapability,
  AdapterKind,
  AdapterSearchHit,
  AdapterSearchInput,
  AdapterValidateInput,
  ParseInput,
  ParseResult,
} from '../../types/adapter.js'
import type { JsTsAdapterIdentity } from '../../types/jsts.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import type { ResolveTargetInput, ResolveTargetResult } from '../../types/target.js'
import type { ValidationResult } from '../../types/validation.js'
import { jsTsSyntaxDiagnostics, parseJsTs, selectJsTsSymbols } from '../../utils/jsts-ast.js'
import { jsTsSymbolTarget, qualifiedSymbolName } from '../../utils/targets.js'
import { ProjectTuning } from '../../utils/tuning.js'

export class JsTsFileAdapter implements FileAdapter {
  public readonly id: string
  public readonly kind: AdapterKind = 'code'
  public readonly priority: number
  public readonly capabilities: AdapterCapability[] = [
    'read',
    'search',
    'resolve',
    'validate',
    'symbols',
  ]
  private readonly checkId: string

  public constructor(identity: JsTsAdapterIdentity) {
    this.id = identity.adapterId
    this.priority = identity.priority
    this.checkId = identity.checkId
  }

  public parse(input: ParseInput): ParseResult {
    const { snapshot } = input
    const content = snapshot.content ?? ''
    const parsed = parseJsTs(snapshot.path, content)
    return {
      ok: isEmpty(parsed.diagnostics),
      diagnostics: jsTsSyntaxDiagnostics(snapshot.path, content, this.id),
      ast: { kind: 'typescript.SourceFile', fileName: parsed.sourceFile.fileName },
      symbols: parsed.symbols,
    }
  }

  public search(input: AdapterSearchInput): AdapterSearchHit[] {
    const { snapshot, query, maxResults, caseSensitive } = input
    const fold = (text: string) => (isTrue(caseSensitive) ? text : text.toLowerCase())
    const needle = fold(query)
    return parseJsTs(snapshot.path, snapshot.content ?? '')
      .symbols.filter((symbol) =>
        [symbol.name, symbol.container ?? ''].some((field) => fold(field).includes(needle))
      )
      .slice(0, maxResults ?? ProjectTuning.adapters.jsTsSymbolHits)
      .map((symbol) => {
        const name = fold(symbol.name)
        return {
          path: snapshot.path,
          score: name === needle ? 5 : name.includes(needle) ? 4 : 2,
          kind: 'symbol' as const,
          range: symbol.range,
          snippet: qualifiedSymbolName(symbol),
          adapterId: this.id,
        }
      })
  }

  public resolveTarget(
    input: ResolveTargetInput & { snapshot: FileSnapshot }
  ): ResolveTargetResult {
    if (input.baseRevision && input.baseRevision !== input.snapshot.revision)
      return {
        status: 'not_found',
        reason: `baseRevision 不匹配：${input.baseRevision} != ${input.snapshot.revision}`,
      }
    const wanted = input.target?.symbol
    if (!wanted?.name) return { status: 'not_found', reason: `${this.id} 需要 symbol name` }
    const matches = selectJsTsSymbols(
      parseJsTs(input.snapshot.path, input.snapshot.content ?? '').symbols,
      wanted
    )
    if (isEmpty(matches))
      return {
        status: 'not_found',
        reason: `未找到符号：${wanted.container ? `${wanted.container}.` : ''}${wanted.name}`,
      }
    if (matches.length > 1)
      return {
        status: 'ambiguous',
        reason: `找到 ${matches.length} 个名为 ${wanted.name} 的 JS/TS 符号`,
        candidates: matches.map((symbol) => jsTsSymbolTarget(input, symbol, 0.82, this.id)),
      }
    return { status: 'resolved', target: jsTsSymbolTarget(input, matches[0], 0.98, this.id) }
  }

  public validate(input: AdapterValidateInput): ValidationResult {
    const { snapshot, changedContent } = input
    const diagnostics = jsTsSyntaxDiagnostics(
      snapshot.path,
      changedContent ?? snapshot.content ?? '',
      this.id
    )
    const ok = isEmpty(diagnostics)
    return { ok, diagnostics, checks: [{ id: this.checkId, ok, diagnostics }] }
  }
}
