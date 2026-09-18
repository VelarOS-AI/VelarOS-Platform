/**
 * 可移植数据：经过空间端口（`ProjectSpacePort`）流动的数据形状，以及宿主实现代码查询要认的查询形状。
 * 不 import 任何东西（只从常量表 import type），不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/velar/project/contracts` 取。
 */

import type { ProjectCodeLanguageActions } from '../contract/constants.js'

// ── 项目修改授权 ──────────────────────────────────────────────────

/** 项目写操作的授权请求：做什么、在哪个目录、会写哪些文件（相对项目根）。这是全仓唯一权威定义。 */
export interface ProjectMutationAuthorizationInput {
  /** 给用户看的操作名，如「编辑项目源码」。 */
  operation: string
  /** 跑命令时的工作目录（相对项目根，空间已核对过在项目之内）；文件改动不带。 */
  cwd?: string
  /** 这次会写入的文件（相对项目根）：文件改动在规划之后、提交之前填，命令不填。 */
  paths?: string[]
}

/** 一条路径的写治理判定：不许写时 reason 是合同错误原因（PERMISSION_DENIED、SCOPE_VIOLATION、PROTECTED_FILE、GENERATED_FILE）。 */
export interface ProjectWriteAuthorization {
  /** 判定的是哪条路径，原样回给调用方。 */
  path: string
  /** 项目允不允许写这条路径。 */
  allowed: boolean
  /** 不许写时的原因码。 */
  reason?: string
  /** 不许写时给模型看的说明。 */
  message?: string
}

/** 项目变更授权的决定：批不批准，以及给模型看的说明（被拒时就是拒绝原因）。宿主自己的实现可以多返回字段，结构上兼容。 */
export interface ProjectAuthorizationDecision {
  /** 用户或策略允不允许这次写操作。 */
  approved: boolean
  /** 给模型看的说明：批准时是放行理由，被拒时是拒绝原因，工具原样交给模型。 */
  message: string
}

// ── 宿主代码查询（ProjectSpacePort.queryCode 收到的查询） ─────────────────
// `velar:code` 的入参由本包翻译成下面的查询交给宿主：语言服务类动作（find_symbols 等七个）由宿主的语言服务执行，
// 其余是代码索引类动作，宿主有代码图谱时执行。入参已经核对过，条数上限由本包填（ProjectCodeLimits.results）。

/**
 * @AgentView
 * 代码查询共用的范围：language 只查这一种语言、extensions 只扫这些扩展名（最多 20 个）、maxDepth 往下扫几层目录（0–16）。
 * 模型的 `velar:code` 入参与宿主收到的语言服务查询共用它；路径一律相对项目根。
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
 * limit 是这次最多交回几条，封顶时结果里标 truncated：`velar:code` 总是给 ProjectCodeLimits.results（只为守住内存），
 * 宿主自己发的查询不给时由语言服务用它的缺省。
 */
export type ProjectCodeLanguageQuery = ProjectCodeScope & { limit?: number } & (
  | { action: 'find_symbols'; query?: string; path?: string; kinds?: string[]; exact?: boolean }
  | { action: 'list_exports'; path?: string; query?: string; includeReExports?: boolean }
  | { action: 'find_imports'; path?: string; specifier?: string; kind?: string; includeExternal?: boolean }
  | { action: 'find_importers'; targetPath?: string; specifier?: string; path?: string; includeReExports?: boolean }
  | { action: 'find_references'; symbol: string; path?: string; exactWord?: boolean }
  | { action: 'language_diagnostics'; path: string }
  | { action: 'analyze_symbol_impact'; symbol: string; path?: string; declarationPath?: string; kinds?: string[] }
)

/** 语言服务类动作的名字，和常量表 `ProjectCodeLanguageActions` 一一对应。 */
export type ProjectCodeLanguageAction = (typeof ProjectCodeLanguageActions)[number]

/** 宿主 queryCode 收到的一条查询：语言服务类或代码索引类。 */
export type ProjectCodeQuery = ProjectCodeLanguageQuery | ProjectCodeIndexQuery
