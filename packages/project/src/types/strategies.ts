import type { JsonValue, OffsetRange } from './common.js'
import type { EditOperation } from './edit.js'

export interface TextMatchSelectionOperation {
  expectedMatches?: number
  occurrence?: number
  replaceAll?: boolean
}

export interface SelectedTextMatches {
  indices: number[]
  matchedText: string
  replacementText?: string
  totalMatches: number
  /** 发生行尾空白宽容匹配时写入补丁 metadata，由 Agent 边界回显给模型。 */
  matchNote?: string
}

export type SymbolOperation = Extract<
  EditOperation,
  {
    type: 'replace_symbol' | 'insert_around_symbol' | 'insert_before_symbol' | 'insert_after_symbol'
  }
>

/** 同一实现以不同身份注册：核心策略与 TypeScript 插件策略只差 id 与优先级。 */
export interface JsTsPatchStrategyIdentity {
  id: string
  priority: number
}

export interface LocatedSymbol {
  range: OffsetRange
  /** insert_* 的锚点：多声明语句里的绑定取整条语句，插入永远落在语句边界上，不会切进声明列表中间。 */
  anchor: OffsetRange
  body?: OffsetRange
}

export type JsonContainer = JsonValue[] | { [key: string]: JsonValue }

export type JsonPatch =
  { op: 'add' | 'replace'; path: string; value: JsonValue } | { op: 'remove'; path: string }
