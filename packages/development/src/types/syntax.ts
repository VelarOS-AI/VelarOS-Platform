/**
 * 语法层的中间形状：内核符号表的原始条目、还没贴上语言 id 的记录，以及 Python 语法树节点。
 * 都只在包内流动，不出包。
 */
import type {
  LanguageExportRecord,
  LanguageImportRecord,
  LanguageSymbolRecord,
} from './language.js'

/** 项目内核符号表里的一条原始记录：字段大多可缺，语言服务补齐后才成为 `LanguageSymbolRecord`。 */
export interface KernelSymbol {
  /** 符号名。 */
  name: string
  /** 符号种类；内核没给时按 `unknown` 处理。 */
  kind?: string
  /** 外层容器名。 */
  container?: string
  /** 内核适配器直接判定的导出与否；没判定就由语法层补。 */
  exported?: boolean
  /** 所在文件；内核按查询文件回填。 */
  path?: string
  /** 所在行，从 1 起。 */
  line?: number
  /** 所在列，从 1 起。 */
  column?: number
  /** 符号占据的区间；给了就优先于 `line` / `column`。 */
  range?: {
    /** 起始行，从 1 起。 */
    startLine?: number
    /** 结束行，从 1 起。 */
    endLine?: number
    /** 起始列，从 1 起。 */
    startColumn?: number
    /** 结束列，从 1 起。 */
    endColumn?: number
  }
  /** 给出这条记录的内核语言适配器 id。 */
  adapterId?: string
  /** 适配器附带的元数据；`exported` 也可能藏在这里。 */
  metadata?: Record<string, any>
}

/** JavaScript / TypeScript 语法层解析出的符号，贴语言 id 之前的形状。 */
export type JsTsSymbolRecord = Omit<LanguageSymbolRecord, 'language'>

/** JavaScript / TypeScript 语法层解析出的引入语句，贴语言 id 之前的形状。 */
export interface JsTsImportRecord extends Omit<LanguageImportRecord, 'language' | 'kind'> {
  /** 语句种类，收窄成 JS/TS 真会出现的四种。 */
  kind: 'import' | 'export-from' | 'require' | 'dynamic-import'
}

/** JavaScript / TypeScript 语法层解析出的导出，贴语言 id 之前的形状。 */
export type JsTsExportRecord = Omit<LanguageExportRecord, 'language'>

/** `@codemirror/lang-python` 语法树节点里本包用到的那几项。 */
export interface PythonSyntaxNode {
  /** 节点类型名（`FunctionDefinition`、`VariableName`…）。 */
  name: string
  /** 节点在源文本里的起始偏移。 */
  from: number
  /** 节点在源文本里的结束偏移。 */
  to: number
  /** 第一个子节点；没有就是 `null`。 */
  firstChild: Nullable<PythonSyntaxNode>
  /** 下一个兄弟节点；没有就是 `null`。 */
  nextSibling: Nullable<PythonSyntaxNode>
}

/** `import a.b as c` / `from m import x as y` 里的一组：说明符加它引进来的名字。 */
export interface PythonImportGroup {
  /** 模块说明符，已去掉空白。 */
  specifier: string
  /** 这一组引进来的名字（有 `as` 就是别名）。 */
  importedName: string
}
