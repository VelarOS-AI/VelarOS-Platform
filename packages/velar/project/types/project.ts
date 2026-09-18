/**
 * 可移植数据：宿主实现代码查询（`ProjectSpacePort.queryCode`）要认的查询形状。
 * 不 import 任何东西（只从常量表 import type），不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/velar/project/contracts` 取。
 */

import type { ProjectCodeLanguageActions } from '../contract/constants.js'

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
