import type { Diagnostic, Range } from './common.js'
import type { PreparedPatch,PrepareEditInput } from './edit.js'
import type { FileSnapshot } from './snapshot.js'
import type { ResolveTargetInput, ResolveTargetResult } from './target.js'
import type { ValidationResult } from './validation.js'

/** 文件快照的粗粒度内容类型，用来选择最安全的 adapter。 */
export type AdapterKind =
  | 'text'
  | 'code'
  | 'structured-data'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'image'
  | 'binary'

/** adapter 实例声明的可选能力。 */
export type AdapterCapability =
  | 'read'
  | 'search'
  | 'resolve'
  | 'prepare_edit'
  | 'validate'
  | 'render'
  | 'symbols'

export interface ParseInput {
  snapshot: FileSnapshot
}

export interface ParseResult {
  ok: boolean
  diagnostics?: Diagnostic[]
  ast?: any
  /** parser-backed adapter 产出的稳定符号，用于目标解析和大纲视图。 */
  symbols?: SymbolInfo[]
}

/** 启发式、tree-sitter、LSP 和 TS adapter 共用的标准化符号描述。 */
export interface SymbolInfo {
  kind: string
  name: string
  container?: string
  exported?: boolean
  range: Range
  signatureHash?: string
  metadata?: Record<string, any>
}

/**
 * `Workspace.listSymbols()` 返回的统一符号形状。
 *
 * `range` 是规范位置；顶层 line/column 字段保留给 1.x 消费方，并与 range
 * 保持一致。
 */
export interface WorkspaceSymbol extends SymbolInfo {
  path: string
  adapterId: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  nodeId?: LooseOptional<string>
  signature?: LooseOptional<string>
}

export interface AdapterSearchInput {
  snapshot: FileSnapshot
  query: string
  regex?: boolean
  maxResults?: number
  caseSensitive?: boolean
}

export interface AdapterSearchHit {
  path: string
  score: number
  /** 命中类型让调用方区分文本、符号和元数据匹配的排序权重。 */
  kind: 'text' | 'symbol' | 'metadata'
  range?: Range
  snippet?: string
  adapterId: string
}

export interface AdapterPrepareEditInput extends PrepareEditInput {
  /** prepareEdit 运行时目标文件的最新快照。 */
  snapshot: FileSnapshot
}

export interface AdapterValidateInput {
  snapshot: FileSnapshot
  transactionId?: string
  changedContent?: string
}

export interface FileAdapter {
  id: string
  kind: AdapterKind
  /** 搜索、目标解析和编辑时优先尝试 priority 更高的 adapter。 */
  priority?: number
  capabilities: AdapterCapability[]
  parse?(input: ParseInput): Promise<ParseResult> | ParseResult
  search?(input: AdapterSearchInput): Promise<AdapterSearchHit[]> | AdapterSearchHit[]
  resolveTarget?(
    input: ResolveTargetInput & { snapshot: FileSnapshot }
  ): Promise<ResolveTargetResult> | ResolveTargetResult
  prepareEdit?(input: AdapterPrepareEditInput): Promise<PreparedPatch[]> | PreparedPatch[]
  validate?(input: AdapterValidateInput): Promise<ValidationResult> | ValidationResult
}

export interface FileAdapterFactory {
  id: string
  /** 创建 adapter 前对每个文件快照执行的快速适配性检查。 */
  canHandle(snapshot: FileSnapshot): Promise<boolean> | boolean
  create(input: { snapshot: FileSnapshot; kernel: any }): Promise<FileAdapter> | FileAdapter
}
