import type { Dirent } from 'node:fs'

import type { CommandProvider } from '../contract/requires.js'

import type { ProjectFileAccess } from './file-access.js'
import type { FileListEntry, SearchHit } from './io.js'
import type { CorePolicy } from './policy.js'
import type { CommandToolRequirement,FileFilterInput } from './provider.js'

export type Matcher = (input: string) => boolean;

export type MatcherCompiler = (pattern: string) => Matcher;

export interface GitignoreRule {
  negated: boolean;
  patterns: string[];
}

export interface RipgrepSearchContext {
  rootAbs: string
  /** rootAbs 下用于收窄搜索范围的相对目录（可选）。 */
  subdirRel?: string
  query: string
  regex: boolean
  caseSensitive?: boolean
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  maxResults: number
  /** 已授权且可由 rg 精确解释的路径；在命中数上限之前过滤。 */
  filterPath?: (path: string) => boolean
  command: CommandProvider
  policy: CorePolicy
}

export interface RgMatchPayload {
  path?: { text?: string }
  lines?: { text?: string }
  line_number?: number
  submatches?: Array<{ start?: number; end?: number }>
}

export interface RgMessage {
  type?: string
  data?: RgMatchPayload
}

export interface RipgrepSearchResult {
  hits: Nullable<SearchHit[]>
  timedOut?: boolean
  truncated?: boolean
  diagnostics?: string[]
  toolRequirements?: CommandToolRequirement[]
}

/** 文本切片以及继续有界读取所需的元数据。 */
export interface ByteLimitedContent {
  content: string
  truncated: boolean
  lineCount: number
  /** 从原始输入消费的 UTF-16 code units；可能包含为保持完整行而省略的末尾换行。 */
  consumedChars: number
}

export interface LineWindowReadResult {
  content: string
  range: { startLine: number; endLine: number }
  hasMore: boolean
  /** 只有读到文件末尾时才确定的总行数，计数口径与内存路径一致（按 \n 切分）。 */
  totalLines?: number
}

export interface ReadCursor {
  line: number
  column: number
}

export interface ListingDependencies {
  readonly root: string
  readonly command: CommandProvider
  readonly authorize: ProjectFileAccess['authorize']
  readonly allowed: (
    path: string,
    action: FileFilterInput['action'],
    options?: { skipFileFilter?: boolean },
  ) => Promise<boolean>
}

/** listFiles 发现阶段通过全部过滤的条目；children 只在该目录被深入时填充。 */
export interface ListingNode {
  readonly entry: FileListEntry
  readonly included: boolean
  readonly children: ListingNode[]
}

/** 待读取的目录：读到的条目挂到 children 下；rules 是从根目录累积到它父目录的 gitignore 规则。 */
export interface ListingDirectory {
  readonly abs: string
  readonly rel: string
  readonly children: ListingNode[]
  readonly rules: readonly GitignoreRule[]
}

/** 一个目录读到的条目，连同判定它们所用的规则（根目录到该目录逐级累积）。 */
export interface ListedDirectory {
  readonly directory: ListingDirectory
  readonly rules: readonly GitignoreRule[]
  readonly entries: ReadonlyArray<{ entry: Dirent; abs: string; rel: string }>
}
