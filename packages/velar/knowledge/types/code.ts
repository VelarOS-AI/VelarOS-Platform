/** 代码智能的数据形状：符号、节点、边、子图与四类请求。能力端口本身在 `contract/requires.ts`。 */

/** 正则扫描出的代码符号种类。 */
export type KnowledgeCodeSymbolKind =
  | 'class'
  | 'enum'
  | 'export'
  | 'function'
  | 'interface'
  | 'type'
  | 'variable'

/** 一个从源码里扫出来的符号，用来做代码分块与符号提示排序。 */
export interface KnowledgeCodeSymbol {
  /** 符号所在文件的工作区相对路径。 */
  path: string
  /** 符号名。 */
  name: string
  /** 符号种类。 */
  kind: KnowledgeCodeSymbolKind
  /** 所在行，从 1 开始。 */
  line: number
  /** 所在列，从 1 开始。 */
  column: number
  /** 是不是导出的符号。 */
  exported: boolean
}

/** 宿主代码图里一个节点的种类。 */
export type KnowledgeCodeNodeKind =
  | 'file'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'
  | 'route'
  | 'module'
  | 'other'

/** 一段代码在文件里的行列范围。 */
export interface KnowledgeCodeRange {
  /** 起始行。 */
  startLine: number
  /** 起始列。 */
  startColumn: number
  /** 结束行。 */
  endLine: number
  /** 结束列。 */
  endColumn: number
}

/** 宿主代码图里的一个节点。 */
export interface KnowledgeCodeNode {
  /** 节点在宿主代码图里的唯一 id。 */
  id: string
  /** 节点种类。 */
  kind: KnowledgeCodeNodeKind
  /** 节点名。 */
  name: string
  /** 带作用域前缀的全名。 */
  qualifiedName: string
  /** 节点所在文件路径。 */
  filePath: string
  /** 语言标识。 */
  language: string
  /** 节点在文件里的范围。 */
  range: KnowledgeCodeRange
  /** 可选的签名文本。 */
  signature?: LooseOptional<string>
  /** 是不是导出的节点。 */
  isExported: boolean
  /** 宿主后端自带的附加信息，本包只透传。 */
  backendMetadata?: Record<string, unknown>
}

/** 宿主代码图里的一条边。 */
export interface KnowledgeCodeEdge {
  /** 边的唯一 id。 */
  id: string
  /** 边的种类，由宿主定义。 */
  kind: string
  /** 起点节点 id。 */
  fromNodeId: string
  /** 终点节点 id。 */
  toNodeId: string
  /** 宿主后端自带的附加信息，本包只透传。 */
  backendMetadata?: Record<string, unknown>
}

/** 一次相关上下文查询返回的子图。 */
export interface KnowledgeCodeSubgraph {
  /** 子图里的节点。 */
  nodes: KnowledgeCodeNode[]
  /** 子图里的边。 */
  edges: KnowledgeCodeEdge[]
  /** 结果是不是被截断了。 */
  truncated?: boolean
}

/** 一条按相关性排序的代码节点命中。 */
export interface KnowledgeCodeSearchResult {
  /** 命中的节点。 */
  node: KnowledgeCodeNode
  /** 相关性分数，越大越相关。 */
  score: number
}

/** 按关键词搜代码节点的请求。 */
export interface KnowledgeCodeNodeSearchRequest {
  /** 项目根目录。 */
  projectRoot: string
  /** 搜索词。 */
  query: string
  /** 只要某一种节点。 */
  kind?: KnowledgeCodeNodeKind
  /** 最多返回几个。 */
  limit?: number
}

/** 取某个文件里全部代码节点的请求。 */
export interface KnowledgeCodeFileNodeRequest {
  /** 项目根目录。 */
  projectRoot: string
  /** 文件路径。 */
  path: string
}

/** 按任务描述取相关代码子图的请求。 */
export interface KnowledgeCodeRelevantContextRequest {
  /** 项目根目录。 */
  projectRoot: string
  /** 任务描述或查询词。 */
  query: string
  /** 子图最多包含几个节点。 */
  maxNodes?: number
}

/** 取某个代码节点原文的请求。 */
export interface KnowledgeCodeNodeRequest {
  /** 项目根目录。 */
  projectRoot: string
  /** 节点 id。 */
  nodeId: string
}

/** 从一份源码里扫出来的一条导入记录。 */
export interface KnowledgeCodeImportRecord {
  /** 导入写的模块说明符。 */
  specifier: string
  /** 这条导入所在文件的路径。 */
  path: string
  /** 是不是相对导入。 */
  isRelative: boolean
}
