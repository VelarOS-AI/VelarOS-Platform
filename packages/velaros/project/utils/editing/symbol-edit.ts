// 域：JS/TS 符号级编辑（replace_symbol、insert_*_symbol）的定位与拼接，核心 JS/TS 补丁策略与 TypeScript 插件的策略共用。
import { isEmpty, isPresent } from '@velaros-ai/core'

import type { EditOperation } from '../../types/edit.js'
import type { SourceSplice } from '../../types/editing.js'
import type { JsTsSymbol } from '../../types/jsts.js'
import type { PatchStrategyInput } from '../../types/patch.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import type { LocatedSymbol, SymbolOperation } from '../../types/strategies.js'
import { ProjectError } from '../errors.js'
import { isJsTsPath, parseJsTs, selectJsTsSymbols } from '../jsts-ast.js'
import { ProjectTuning } from '../tuning.js'

/** 操作是不是按符号定位的四种之一。 */
export function isSymbolOperation(operation: EditOperation): operation is SymbolOperation {
  return (
    operation.type === 'replace_symbol' ||
    operation.type === 'insert_around_symbol' ||
    operation.type === 'insert_before_symbol' ||
    operation.type === 'insert_after_symbol'
  )
}

/** 由定位到的符号算出拼接：整体替换、只换 body，或在锚点前后插入。 */
export function symbolSplice(located: LocatedSymbol, operation: SymbolOperation): SourceSplice {
  switch (operation.type) {
    case 'replace_symbol': {
      if (operation.mode !== 'body')
        return {
          start: located.range.startOffset,
          end: located.range.endOffset,
          text: operation.replacement,
        }
      if (!located.body) {
        throw new ProjectError(
          'TARGET_NOT_FOUND',
          'replace_symbol mode=body 需要可替换的 body（函数/方法的块体或箭头表达式体，类、interface、enum、namespace 的花括号体）；该目标没有，请改用 mode=whole',
        )
      }
      return {
        start: located.body.startOffset,
        end: located.body.endOffset,
        text: operation.replacement,
      }
    }
    case 'insert_around_symbol': {
      const at =
        operation.position === 'before' ? located.anchor.startOffset : located.anchor.endOffset
      return { start: at, end: at, text: operation.text }
    }
    case 'insert_before_symbol':
      return {
        start: located.anchor.startOffset,
        end: located.anchor.startOffset,
        text: operation.text,
      }
    case 'insert_after_symbol':
      return {
        start: located.anchor.endOffset,
        end: located.anchor.endOffset,
        text: operation.text,
      }
  }
}

/**
 * 定位符号操作的区间。已解析 target 带偏移时以它为准，并对齐到同一 AST 符号以取得 body 与插入锚点；
 * 否则按 operation.symbol 在 AST 中唯一匹配。范围永远来自 AST，不做括号计数式推断——非 JS/TS 目标
 * 因此没有 body，mode=body 显式失败而不是猜一个区间。
 */
export function locateSymbol(
  input: PatchStrategyInput,
  snapshot: FileSnapshot,
  content: string,
  operation: SymbolOperation,
): LocatedSymbol {
  const range = input.target?.range
  if (isPresent(range?.startOffset) && isPresent(range.endOffset)) {
    const aligned = isJsTsPath(snapshot.path)
      ? parseJsTs(snapshot.path, content).symbols.find(
          (symbol) =>
            symbol.range.startOffset === range.startOffset &&
            symbol.range.endOffset === range.endOffset,
        )
      : undefined
    if (aligned) return locatedFrom(aligned)
    const offsets = { startOffset: range.startOffset, endOffset: range.endOffset }
    return { range: offsets, anchor: offsets }
  }

  // 只带行号的 target（如代码智能定位）没有偏移，退回用它的符号描述在 AST 里重新定位。
  const query = operation.symbol ?? input.target?.symbol
  if (!query)
    throw new ProjectError(
      'TARGET_NOT_FOUND',
      `${operation.type} 需要 targetId 或 operation.symbol`,
    )
  if (!isJsTsPath(snapshot.path))
    throw new ProjectError(
      'NOT_SUPPORTED',
      `${operation.type} 按 symbol 定位只支持 JS/TS 文件：${snapshot.path}`,
    )
  const matches = selectJsTsSymbols(parseJsTs(snapshot.path, content).symbols, query)
  const label = `${query.container ? `${query.container}.` : ''}${query.name}`
  if (isEmpty(matches))
    throw new ProjectError('TARGET_NOT_FOUND', `${operation.type} 未找到符号：${label}`)
  if (matches.length > 1) {
    throw new ProjectError(
      'AMBIGUOUS_TARGET',
      `${operation.type} 找到 ${matches.length} 个名为 ${label} 的符号：${matches.slice(0, ProjectTuning.editing.symbolCandidates).map(describeSymbol).join('；')}`,
      { candidates: matches.map(describeSymbol) },
      '请补充 symbol.kind（成对访问器可写 getter / setter）或 symbol.container，使其只匹配一个符号。',
    )
  }
  return locatedFrom(matches[0])
}

/** 由 AST 符号取出整体范围、插入锚点（多声明语句取整条语句）与 body。 */
function locatedFrom(symbol: JsTsSymbol): LocatedSymbol {
  return {
    range: symbol.range,
    anchor: symbol.statementRange ?? symbol.range,
    body: symbol.bodyRange,
  }
}

/** 给歧义报错用的一句符号描述：种类、带容器的名字、访问器与起始行号。 */
function describeSymbol(symbol: JsTsSymbol): string {
  const accessor = symbol.metadata.accessor ? `${symbol.metadata.accessor}，` : ''
  return `${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}（${accessor}第 ${symbol.range.startLine} 行）`
}
