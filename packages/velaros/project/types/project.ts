/**
 * 可移植数据：宿主实现代码查询（`ProjectSpacePort.queryCode`）要认的查询形状。
 * 不 import 任何东西（只从常量表 import type），不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/velaros/project/contracts` 取。
 */

import type { ProjectCodeLanguageActions } from '../contract/constants.js'

// ── 宿主代码查询（ProjectSpacePort.queryCode 收到的查询） ─────────────────
// `velaros:code` 的入参由本包翻译成下面的查询交给宿主：语言服务类动作（find_symbols 等七个）由宿主的语言服务执行，
// 其余是代码索引类动作，宿主有代码图谱时执行。入参已经核对过，条数上限由本包填（ProjectCodeLimits.results）。

/**
 * @AgentView
 * 代码查询共用的范围：language 只查这一种语言、extensions 只扫这些扩展名（最多 20 个）、maxDepth 往下扫几层目录（0–16）。
 * 模型的 `velaros:code` 入参与宿主收到的语言服务查询共用它；路径一律相对项目根。
 */
export interface ProjectCodeScope {
  language?: string
  extensions?: string[]
  maxDepth?: number
}

/** 代码索引类查询：按名字搜符号、展开节点、追调用链、看影响面、找环与死代码、路由清单。索引本身的生命周期归宿主，本包不发这类查询。 */
export type ProjectCodeIndexQuery =
  | { action: 'search_symbols'; query: string; kind?: string; limit: number }
  | { action: 'explore'; nodeIds: string[] }
  | { action: 'trace'; fromSymbol: string; toSymbol: string }
  | { action: 'callers'; nodeId: string; depth: number }
  | { action: 'callees'; nodeId: string; depth: number }
  | { action: 'impact'; nodeId: string; depth: number }
  | { action: 'type_hierarchy'; nodeId: string }
  | { action: 'file_dependencies'; path: string }
  | { action: 'find_cycles'; maxFiles?: number }
  | { action: 'find_dead_code'; limit: number }
  | { action: 'routing_manifest'; framework?: string }

/**
 * 语言服务类查询：找符号、列导出、看一个文件引了谁、看谁引了它、找引用、诊断、符号改动的影响面。
 * limit 是这次最多交回几条，封顶时结果里标 truncated：`velaros:code` 总是给 ProjectCodeLimits.results（只为守住内存），
 * 宿主自己发的查询不给时由语言服务用它的缺省。
 */
export type ProjectCodeLanguageQuery = ProjectCodeScope & { limit?: number } & (
    | { action: 'find_symbols'; query?: string; path?: string; kinds?: string[]; exact?: boolean }
    | { action: 'list_exports'; path?: string; query?: string; includeReExports?: boolean }
    | {
        action: 'find_imports'
        path?: string
        specifier?: string
        kind?: string
        includeExternal?: boolean
      }
    | {
        action: 'find_importers'
        targetPath?: string
        specifier?: string
        path?: string
        includeReExports?: boolean
      }
    | { action: 'find_references'; symbol: string; path?: string; exactWord?: boolean }
    | { action: 'language_diagnostics'; path: string }
    | {
        action: 'analyze_symbol_impact'
        symbol: string
        path?: string
        declarationPath?: string
        kinds?: string[]
      }
  )

/** 语言服务类动作的名字，和常量表 `ProjectCodeLanguageActions` 一一对应。 */
export type ProjectCodeLanguageAction = (typeof ProjectCodeLanguageActions)[number]

/** 宿主 queryCode 收到的一条查询：语言服务类或代码索引类。 */
export type ProjectCodeQuery = ProjectCodeLanguageQuery | ProjectCodeIndexQuery

/**
 * 可移植数据：外部语言服务（LSP）交出去的五种数据形状。
 * 不 import、不带行为、不用 Node 类型，随 `./contracts` 出包。
 */

/** 外部语言服务规格：拉起哪个命令、认哪些扩展名、按哪个 LSP languageId 打开文档。 */
export interface ExternalLanguageServerSpec {
  /** 规格 id，也是进程池里的键（`basedpyright`、`gopls`…）。 */
  readonly id: string
  /** 可执行文件名；要由用户自己装到 PATH 上，本包不下载也不安装。 */
  readonly command: string
  /** 启动参数，原样传给命令。 */
  readonly args: readonly string[]
  /** 认的文件扩展名，带点、小写（`.py`、`.rs`）。 */
  readonly extensions: readonly string[]
  /** 打开文档时用的 LSP languageId。 */
  readonly languageId: string
}

/** 外部语言服务发回的一条诊断，位置一律换算成从 1 起的行列。 */
export interface ExternalLanguageDiagnostic {
  /** 严重程度；LSP 的 hint 与 information 一并归进 `info`。 */
  readonly severity: 'error' | 'warning' | 'info'
  /** 诊断所在文件的绝对路径。 */
  readonly path: string
  /** 起始行，从 1 起。 */
  readonly line: number
  /** 起始列，从 1 起。 */
  readonly column: number
  /** 结束行；语言服务没给范围结束时为 `null`。 */
  readonly endLine: Nullable<number>
  /** 结束列；语言服务没给范围结束时为 `null`。 */
  readonly endColumn: Nullable<number>
  /** 语言服务给的诊断码，原样转成字符串；没有就是 `null`。 */
  readonly code: Nullable<string>
  /** 诊断来自哪个语言服务（规格 id）。 */
  readonly source: string
  /** 诊断正文，原样来自语言服务。 */
  readonly message: string
}

/** 一批外部语言服务的整体状态：能不能用、开了几个文件、上一次诊断完不完整。 */
export interface ExternalLanguageStatus {
  /** 还没启动 / 至少一个已就绪 / 都启动失败 / 运行中出错。 */
  readonly state: 'idle' | 'ready' | 'unavailable' | 'error'
  /** 参与的语言服务 id，逗号分隔；一个都没起来时是 `external`。 */
  readonly server: string
  /** 当前打开着的文档数。 */
  readonly openFiles: number
  /** 最近一次失败的说明；已就绪时为 `null`。 */
  readonly error: Nullable<string>
  /**
   * 最近一次 `diagnostics()` 里有几个文件等到超时也没收到语言服务的诊断。
   *
   * 大于 0 时那几个文件的「0 条诊断」**不代表没有问题**：rust-analyzer 这类先发语法诊断、
   * 再发 check 结果的服务，以及 URI 写法与发出去的不完全一致时（Windows 盘符大小写与编码是
   * 常见来源），等不到结果与真的没问题在线上长得一模一样。
   */
  readonly diagnosticsTimedOutFiles: number
  /** 最近一次 `diagnostics()` 的结果是否完整（每个文件都等到了语言服务的答复）。 */
  readonly diagnosticsComplete: boolean
}

/** 跳转结果里的一个位置，位置一律换算成从 1 起的行列。 */
export interface ExternalLanguageLocation {
  /** 目标文件的绝对路径。 */
  readonly path: string
  /** 起始行，从 1 起。 */
  readonly line: number
  /** 起始列，从 1 起。 */
  readonly column: number
  /** 结束行；语言服务没给范围结束时为 `null`。 */
  readonly endLine: Nullable<number>
  /** 结束列；语言服务没给范围结束时为 `null`。 */
  readonly endColumn: Nullable<number>
  /** 目标处的一行预览；本包不读目标文件，恒为 `null`。 */
  readonly preview: Nullable<string>
}

/** 悬停结果：语言服务对某个位置给出的说明文本。 */
export interface ExternalLanguageHover {
  /** 查询所在文件的绝对路径。 */
  readonly path: string
  /** 查询所在行，从 1 起。 */
  readonly line: number
  /** 查询所在列，从 1 起。 */
  readonly column: number
  /** 符号种类；LSP 的 hover 不给这项，恒为 `null`。 */
  readonly kind: Nullable<string>
  /** 主体文本，markdown 与代码块已归一成纯文本。 */
  readonly display: string
  /** 补充文档；LSP 的 hover 把全部内容放在 `display` 里，这里恒为空串。 */
  readonly documentation: string
}
