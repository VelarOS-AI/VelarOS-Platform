export interface FileSearchEntry {
  path: string
  type: 'file' | 'directory'
}

/** 内容搜索命中的一行：定位到文件、行、列，并附一段摘录。 */
export interface FileSearchMatch {
  path: string
  line: number
  column: number
  excerpt: string
}

/** 搜索模式：`paths` 按路径名找条目，`content` 在文件内容里找文本。 */
export type FileSearchMode = 'paths' | 'content'

/** 路径模式下的匹配方式：包含、精确、模糊。 */
export type FileSearchPathMatchMode = 'contains' | 'exact' | 'fuzzy'

/**
 * 系统范围搜索的输入。
 *
 * 未给出的字段一律由实现取默认值：默认根目录、默认条数上限、默认深度上限。
 * `unrestricted` 只表达调用方的意愿，实现仍会跳过受系统保护的目录（见不变量登记）。
 */

/** 宿主项目文件浏览器的本机搜索数据。 */
export interface FileSearchOptions {
  query: string
  mode?: FileSearchMode
  rootPath?: string
  limit?: number
  maxDepth?: number
  entryTypes?: Array<FileSearchEntry['type']>
  pathMatchMode?: FileSearchPathMatchMode
  extensions?: string[]
  caseSensitive?: boolean
  regex?: boolean
  maxResultsPerFile?: number
  includeHidden?: boolean
  unrestricted?: boolean
}

/**
 * 系统范围搜索的输出。
 *
 * `count` 是本次返回的条数；`truncated` 为 true 表示还有结果没有返回，而不是搜索失败。
 * 路径模式填 `entries`，内容模式填 `matches`，两者不会同时出现。
 */
export interface FileSearchResult {
  mode: FileSearchMode
  rootPath: string
  count: number
  truncated: boolean
  entries?: FileSearchEntry[]
  matches?: FileSearchMatch[]
}

/**
 * 路径判定的工作数据：搜索跳过受保护目录时的入参。只在包内用，不出包。
 */

/** 判断一个候选目录是不是受系统保护、搜索时要跳过的目录：平台、家目录、搜索根、候选路径。 */
export interface FileSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}
