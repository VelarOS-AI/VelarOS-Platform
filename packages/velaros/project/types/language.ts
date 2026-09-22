/**
 * 语言查询的工作类型：七个动作的入参、四类记录、各自的结果，以及两个内置语言服务共同实现的行为接口。
 * 都是包内工作类型，出包的只有合同签名闭包用得上的那几个。
 */
import type { LanguageToolContext } from '../contract/requires.js'

/** 七个动作共有的入参：按路径与扩展名收窄扫描面，按 limit 截结果。 */
export interface LanguageQueryInput extends Record<string, any> {
  /** 起始路径，相对项目根；省略就是整个项目。 */
  path?: string
  /** 结果条数上限；省略取可调参数表里的缺省条数。 */
  limit?: number
  /** 只扫这些扩展名（不带点）；省略取语言服务自己的缺省集合。 */
  extensions?: string[]
  /** 目录遍历最深几层；省略取可调参数表里的缺省深度。 */
  maxDepth?: number
}

/** 一个符号：名字、种类、位置、导出与否。 */
export interface LanguageSymbolRecord {
  /** 所在文件，相对项目根。 */
  path: string
  /** 符号名。 */
  name: string
  /** 符号种类（function、class、method…），语言服务自己的词表。 */
  kind: string
  /** 给出这条记录的语言服务 id。 */
  language: string
  /** 外层容器名（类名、命名空间名）；顶层符号没有。 */
  container?: string
  /** 所在行，从 1 起。 */
  line: number
  /** 所在列，从 1 起。 */
  column: number
  /** 这个符号是不是模块的导出。 */
  exported: boolean
  /** 符号来自内核的哪个语言适配器；语法层自己解析出来的没有。 */
  adapterId?: string
}

/** 一条 import / require / 动态 import / `export … from`。 */
export interface LanguageImportRecord {
  /** 所在文件，相对项目根。 */
  path: string
  /** 所在行，从 1 起。 */
  line: number
  /** 所在列，从 1 起。 */
  column: number
  /** 给出这条记录的语言服务 id。 */
  language: string
  /** 语句种类（import、require、dynamic-import、export-from、from-import）。 */
  kind: string
  /** 模块说明符原文。 */
  specifier: string
  /** 说明符是不是相对路径。 */
  isRelative: boolean
  /** 是不是 `import type` 这类只搬类型的写法。 */
  isTypeOnly: boolean
  /** 这条语句引进来的名字。 */
  importedNames: string[]
  /** 语句原文，压成一行并按摘录上限截断。 */
  raw: string
  /** 说明符在本次扫描的文件集合里解析到的目标路径；解析不到就没有。 */
  resolvedPath?: LooseOptional<string>
}

/** 一条导出（含 `export { x as y }` 与 `export … from`）。 */
export interface LanguageExportRecord {
  /** 所在文件，相对项目根。 */
  path: string
  /** 所在行，从 1 起。 */
  line: number
  /** 所在列，从 1 起。 */
  column: number
  /** 给出这条记录的语言服务 id。 */
  language: string
  /** 对外的名字。 */
  name: string
  /** 导出的种类（function、class、variable、export、default…）。 */
  kind: string
  /** 本地名；`export { local as name }` 时与 `name` 不同。 */
  localName?: string
  /** 转发来源模块；不是转发就没有。 */
  source?: string
  /** 这条是不是从别的模块转发出去的。 */
  reExport: boolean
}

/** 一处引用：位置加那一行的摘录。 */
export interface LanguageReferenceRecord {
  /** 所在文件，相对项目根。 */
  path: string
  /** 所在行，从 1 起。 */
  line: number
  /** 所在列，从 1 起。 */
  column: number
  /** 给出这条记录的语言服务 id。 */
  language: string
  /** 那一行的正文，已去掉首尾空白。 */
  excerpt: string
}

/** 一条诊断：位置区间、严重程度与正文。 */
export interface LanguageDiagnosticRecord {
  /** 所在文件，相对项目根。 */
  path: string
  /** 起始行，从 1 起。 */
  line: number
  /** 起始列，从 1 起。 */
  column: number
  /** 结束行，从 1 起。 */
  endLine: number
  /** 结束列，从 1 起。 */
  endColumn: number
  /** 给出这条诊断的语言服务 id。 */
  language: string
  /** 严重程度。 */
  severity: 'error' | 'warning' | 'info'
  /** 诊断正文。 */
  message: string
  /** 诊断的产出方（目前只有 `typescript`）。 */
  source: string
  /** 诊断码；没有就省略。 */
  code?: number
}

/** `find_symbols` 的结果。 */
export interface LanguageSymbolResult {
  /** 命中的符号，已按 limit 截断。 */
  symbols: LanguageSymbolRecord[]
  /** 命中的符号总数（截断前）。 */
  symbolCount: number
  /** 实际扫过的文件数。 */
  scannedFiles: number
  /** 实际看过的符号数（含被过滤掉的）。 */
  scannedSymbols: number
  /** 文件清单是不是被遍历上限截断了。 */
  fileListTruncated: boolean
  /** 结果是不是被 limit 截断了。 */
  truncated: boolean
}

/** `list_exports` 的结果。 */
export interface LanguageExportResult {
  /** 命中的导出，已按 limit 截断。 */
  exports: LanguageExportRecord[]
  /** 命中的导出总数（截断前）。 */
  exportCount: number
  /** 实际扫过的文件数。 */
  scannedFiles: number
  /** 文件清单是不是被遍历上限截断了。 */
  fileListTruncated: boolean
  /** 结果是不是被 limit 截断了。 */
  truncated: boolean
}

/** `find_imports` 的结果。 */
export interface LanguageImportResult {
  /** 命中的 import 语句，已按 limit 截断。 */
  imports: LanguageImportRecord[]
  /** 命中的 import 总数（截断前）。 */
  importCount: number
  /** 实际扫过的文件数。 */
  scannedFiles: number
  /** 文件清单是不是被遍历上限截断了。 */
  fileListTruncated: boolean
  /** 结果是不是被 limit 截断了。 */
  truncated: boolean
}

/** `find_importers` 的结果。 */
export interface LanguageImporterResult {
  /** 引用了目标的 import 语句，已按 limit 截断。 */
  importers: LanguageImportRecord[]
  /** 引用方总数（截断前，是真实总数）。 */
  importerCount: number
  /** 实际扫过的文件数。 */
  scannedFiles: number
  /** 文件清单是不是被遍历上限截断了。 */
  fileListTruncated: boolean
  /** 结果是不是被 limit 截断了。 */
  truncated: boolean
}

/** `find_references` 的结果。 */
export interface LanguageReferenceResult {
  /** 命中的引用，已按 limit 截断。 */
  references: LanguageReferenceRecord[]
  /** 找到的引用数。**扫描提前停止时这是下限**，此时 `referenceCountIsLowerBound` 为真、`note` 里写明。 */
  referenceCount: number
  /** 真为「至少这么多」：凑够 limit+1 条就停了扫，项目里的实际引用只会更多。 */
  referenceCountIsLowerBound?: boolean
  /** 实际扫过的文件数。 */
  scannedFiles: number
  /** 给调用方与模型读的一句话说明（目前只在提前停扫时给）。 */
  note?: string
  /** 结果是不是被 limit 截断了。 */
  truncated?: boolean
}

/** `language_diagnostics` 的结果。 */
export interface LanguageDiagnosticsResult {
  /** 命中的诊断，错误排在警告与提示之前，已按 limit 截断。 */
  diagnostics: LanguageDiagnosticRecord[]
  /** 诊断总数（截断前）。 */
  diagnosticCount: number
  /** 实际完成诊断的文件数。 */
  scannedFiles: number
  /** 文件清单是不是被上限或耗时预算截断了。 */
  fileListTruncated?: boolean
  /** 结果是不是被 limit 截断了。 */
  truncated?: boolean
  /** 诊断能力降级的原因（例如类型检查不可用）；存在时结果不完整，空列表不代表代码没有问题。 */
  degraded?: string
  /** 没有扫描到文件、文件数被截断等调用方必须知道的说明。 */
  note?: string
}

/** 一个语言服务对某个符号做出的影响面分析。 */
export interface LanguageImpactResult {
  /** 给出这份分析的语言服务 id。 */
  language: string
  /** 符号的声明处。 */
  definitions: LanguageSymbolRecord[]
  /** 声明处总数。 */
  definitionCount: number
  /** 引用处，已按 limit 截断。 */
  references: LanguageReferenceRecord[]
  /** 引用数；提前停扫时是下限。 */
  referenceCount: number
  /** 真为「至少这么多」：引用扫描提前停了。 */
  referenceCountIsLowerBound?: boolean
  /** 引用数口径的说明，直接来自 `find_references`。 */
  referenceNote?: string
  /** 引用了声明文件的 import 语句，已按 limit 截断。 */
  importers: LanguageImportRecord[]
  /** 引用方总数。 */
  importerCount: number
  /** 从引用与引用方里挑出来的相关测试文件。 */
  relatedTestPaths: string[]
  /** 这份分析里有没有任何一处被截断。 */
  truncated: boolean
}

/** `find_symbols` 的入参。 */
export interface FindSymbolsInput extends LanguageQueryInput {
  /** 按名字、容器名或路径做子串匹配；省略就列全部。 */
  query?: string
  /** 只要模块导出的符号。 */
  exportedOnly?: boolean
  /** 只要这些种类的符号。 */
  kinds?: string[]
  /** `query` 按全等匹配（也认 `容器.名字`），而不是子串。 */
  exact?: boolean
}

/** `list_exports` 的入参。 */
export interface ListExportsInput extends LanguageQueryInput {
  /** 按导出名做子串匹配；省略就列全部。 */
  query?: string
  /** 把 `export … from` 这类转发也算进来；缺省算。 */
  includeReExports?: boolean
}

/** `find_imports` 的入参。 */
export interface FindImportsInput extends LanguageQueryInput {
  /** 只要这个说明符全等的语句。 */
  specifier?: string
  /** 只要这种语句（import、require、dynamic-import…）。 */
  kind?: string
  /** 把非相对路径（第三方包）的引入也算进来；缺省算。 */
  includeExternal?: boolean
}

/** `find_references` 的入参。 */
export interface FindReferencesInput extends LanguageQueryInput {
  /** 要找的标识符。 */
  symbol: string
  /** 按整词匹配；缺省按整词。 */
  exactWord?: boolean
}

/** `find_importers` 的入参：`targetPath` 与 `specifier` 至少给一个。 */
export interface FindImportersInput extends LanguageQueryInput {
  /** 被引用的文件，相对项目根。 */
  targetPath?: string
  /** 被引用的模块说明符。 */
  specifier?: string
  /** 把 `export … from` 这类转发也算成引用方。 */
  includeReExports?: boolean
}

/** `language_diagnostics` 的入参。 */
export interface LanguageDiagnosticsInput extends LanguageQueryInput {
  /** 要诊断的文件或目录，相对项目根；必填。 */
  path: string
}

/** `analyze_symbol_impact` 的入参。 */
export interface AnalyzeSymbolImpactInput extends LanguageQueryInput {
  /** 要分析的符号名。 */
  symbol: string
  /** 声明所在文件；给了就只在这个文件里找声明。 */
  declarationPath?: string
  /** 只认这些种类的声明。 */
  kinds?: string[]
}

/** 选文件时对内核遍历的约束：起点、扩展名、深度、条数与剪枝规则。 */
export interface SourceFileSelection {
  /** 起始路径，相对项目根；省略就是整个项目。 */
  path?: string
  /** 只要这些扩展名（不带点）。 */
  extensions?: string[]
  /** 最深遍历几层。 */
  maxDepth?: number
  /** 最多选多少个源文件。 */
  maxFiles?: number
  /** 缺省沿用内核规则：跳过 .gitignore 忽略的文件（逐级继承根目录规则）；显式指向的目录本身被忽略时不跳过。 */
  excludeGitignored?: boolean
  /** 遍历中遇到即剪枝的相对路径 glob；起始目录本身不受约束。 */
  exclude?: readonly string[]
}

/** 一次选文件的结果。 */
export interface SourceFileSelectionResult {
  /** 选中的源文件，相对项目根，已排序。 */
  files: string[]
  /** 是不是被文件数上限截断了。 */
  truncated: boolean
}

/**
 * 两个内置语言服务共同实现的行为：七个动作里除影响面分析之外的六件事，外加诊断（可选）。
 *
 * 影响面分析由这六件事组合而成，所以不在这里；`getDiagnostics` 只有 JavaScript / TypeScript 有。
 */
export interface LanguageNavigationService {
  /** 语言服务 id（`jsts`、`python`）。 */
  id: string
  /** 给人和模型看的名字（`JavaScript / TypeScript`）；模型写的语言名从这里认。 */
  label: string
  /** 认的扩展名（不带点）；选服务与缺省扫描面都按它。 */
  extensions: readonly string[]
  /** 列符号。 */
  findSymbols(ctx: LanguageToolContext, input: FindSymbolsInput): Promise<LanguageSymbolResult>
  /** 列导出。 */
  listExports(ctx: LanguageToolContext, input: ListExportsInput): Promise<LanguageExportResult>
  /** 列引入。 */
  findImports(ctx: LanguageToolContext, input: FindImportsInput): Promise<LanguageImportResult>
  /** 找引用。 */
  findReferences(
    ctx: LanguageToolContext,
    input: FindReferencesInput
  ): Promise<LanguageReferenceResult>
  /** 找引用方。 */
  findImporters(
    ctx: LanguageToolContext,
    input: FindImportersInput
  ): Promise<LanguageImporterResult>
  /** 做诊断；不支持诊断的语言服务不实现这一项，调用方据此说明「没做诊断」。 */
  getDiagnostics?(
    ctx: LanguageToolContext,
    input: LanguageDiagnosticsInput
  ): Promise<LanguageDiagnosticsResult>
}

/** 选中的语言服务在结果里的摘要。 */
export interface LanguageServiceSummary {
  /** 语言服务 id。 */
  id: string
  /** 语言服务名字。 */
  label: string
}
