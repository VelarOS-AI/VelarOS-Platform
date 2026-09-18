/** 文件权威层的包内工作类型。 */

import type { MemoryFilesIo } from '../contract/requires.js'

import type { MemoryFilesScopeRoot } from './memory.js'

/** 一个文件权威层后端要什么。 */
export interface MemoryFilesBackendOptions {
  /** 作用域根。传函数时每次调用都会重新求值——项目根随会话切换，宿主不必重建后端。 */
  readonly roots:
    | readonly MemoryFilesScopeRoot[]
    | (() => readonly MemoryFilesScopeRoot[])
  /** 文件系统端口；缺省用纯内存实现（宿主须显式注入 `createNodeMemoryFilesIo()`）。 */
  readonly io?: MemoryFilesIo
  /** 索引文件名；缺省取常量表里的 `MEMORY.md`。 */
  readonly indexFileName?: string
  /** 条目目录名；缺省取常量表里的 `entries`。 */
  readonly entriesDirectoryName?: string
  /** 取当前时间的函数；测试可注入固定时钟。 */
  readonly now?: () => number
}

/** 一条索引行的打分结果：命中哪个根、哪一行、分数多少、原始顺序。 */
export interface ScoredCandidate {
  /** 这条候选来自哪个作用域根。 */
  readonly root: MemoryFilesScopeRoot
  /** 命中的索引行。 */
  readonly entry: MemoryIndexEntry
  /** 词法打分。 */
  readonly score: number
  /** 原始顺序，用于同分时稳定排序。 */
  readonly order: number
}

/** 稳定键 → 条目路径的缓存项。 */
export interface StableKeyCacheEntry {
  /** 条目集合的指纹（索引文本 + 条目目录清单）；对不上就整份重建。 */
  signature: string
  /** 稳定键到相对路径的映射。 */
  readonly paths: Map<string, string>
}

/** 一份记忆条目文档：三个一等字段 + 其余 frontmatter 属性 + 正文。 */
export interface MemoryFileDocument {
  /** 条目标题（frontmatter 的 `name`）。 */
  readonly name: string
  /** 一句话摘要（frontmatter 的 `description`）。 */
  readonly description: string
  /** 条目类型（frontmatter 的 `type`）。 */
  readonly type: string
  /** 一等字段之外的 frontmatter 键值，按出现顺序保留。 */
  readonly attributes: Readonly<Record<string, string>>
  /** frontmatter 之后的正文（已 trim 首尾空行）。 */
  readonly body: string
  /** 该文件是否本来就带 frontmatter；false 表示三个一等字段是从正文推断出来的。 */
  readonly hadFrontmatter: boolean
}

/** 写回一份记忆条目文档要什么。 */
export interface SerializeMemoryFileDocumentInput {
  /** 条目标题。 */
  readonly name: string
  /** 一句话摘要。 */
  readonly description: string
  /** 条目类型。 */
  readonly type: string
  /** 一等字段之外要写回的 frontmatter 键值。 */
  readonly attributes?: Readonly<Record<string, string>>
  /** 正文。 */
  readonly body: string
}

/** `MEMORY.md` 索引里的一行。 */
export interface MemoryIndexEntry {
  /** 相对索引文件的条目路径，如 `entries/some-slug.md`。同时充当该作用域内的稳定键。 */
  readonly path: string
  /** 条目标题。 */
  readonly name: string
  /** 一句话摘要。 */
  readonly description: string
}

/** 解析索引文本时的可选项。 */
export interface ParseMemoryIndexOptions {
  /** 条目目录名；索引行必须指向 `<目录>/<名>.md`，别的形状一律跳过。 */
  readonly entriesDirectoryName?: string
  /** 越界行的诊断口：路径逃出条目目录时先跳过、再把它交给这里（后端记日志）。 */
  readonly onRejectedPath?: (path: string) => void
}
