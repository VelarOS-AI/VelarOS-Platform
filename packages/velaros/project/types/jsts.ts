import type * as ts from 'typescript'

import type { SymbolInfo } from './adapter.js'
import type { OffsetRange, Range } from './common.js'

/** 同一实现以不同身份注册：核心 adapter 与 TypeScript 插件 adapter 只差 id、优先级与检查项名。 */
export interface JsTsAdapterIdentity {
  factoryId: string
  adapterId: string
  priority: number
  checkId: string
}

export type JsTsSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'import'

export type JsTsAccessor = 'get' | 'set'

/** AST 产出的范围总是同时带行列与偏移。 */
export type JsTsRange = Range & OffsetRange

export type JsTsSymbolMetadata = { exported: boolean; accessor?: JsTsAccessor }

export interface JsTsSymbol extends SymbolInfo {
  kind: JsTsSymbolKind
  range: JsTsRange
  metadata: JsTsSymbolMetadata
  /**
   * `const a = …, b = …` 里单个绑定所在的整条语句。range 只覆盖该绑定，替换不牵连兄弟绑定；
   * 插入则必须以整条语句为锚，否则会插进声明列表中间。单声明语句的 range 本就是整条语句，不带此字段。
   */
  statementRange?: JsTsRange
  /**
   * mode:'body' 的可替换区间：花括号界定的体（函数块、类、interface、enum、namespace、对象字面量类型）
   * 取两括号之间，箭头函数的表达式体取表达式本身；重载签名、抽象方法等没有 body 的声明不带此字段。
   */
  bodyRange?: JsTsRange
}

export interface ParsedJsTs {
  sourceFile: ts.SourceFile
  symbols: JsTsSymbol[]
  diagnostics: readonly ts.DiagnosticWithLocation[]
}

export interface JsTsSymbolQuery {
  name?: string
  kind?: string
  container?: string
}

export type OverloadableDeclaration =
  ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration
