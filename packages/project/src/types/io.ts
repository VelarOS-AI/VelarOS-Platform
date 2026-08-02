import type { Range, TrustLabel } from "./common.js";
import type { CommandToolRequirement } from "./provider.js";
import type { FileSnapshot, ProjectSnapshot } from "./snapshot.js";

/** observe 和 list-files 共用的路径发现选项。 */
export interface ObserveInput {
  include?: string[];
  exclude?: string[];
  /** 默认在工作区根目录为 true；当 path 显式指向子树时为 false。 */
  excludeGitignored?: boolean;
  maxFiles?: number;
  /** 相对工作区根目录的起始路径（默认根目录）。 */
  path?: string;
  /** 是否递归进入子目录（默认 false）。 */
  recursive?: boolean;
  /** recursive 为 true 时的最大递归深度（默认 3）。 */
  maxDepth?: number;
}

export interface ReadInput {
  path: string;
  /** 文件 revision 不再匹配该值时拒绝读取。 */
  baseRevision?: string;
  /** 可选的有界行/offset 窗口；大文件调用方应优先使用 range。 */
  range?: Partial<Range>;
  maxBytes?: number;
  maxChars?: number;
  trust?: TrustLabel;
}

export interface ReadResult {
  snapshot: FileSnapshot;
  content?: string;
  range?: Range;
  /** 文件总行数。 */
  totalLines?: number;
  /** 内容因 range 或 maxBytes 被截断时为 true。 */
  truncated?: boolean;
  /** 截断时，下一个读取窗口的起始行。 */
  nextStartLine?: number;
  /** 当前窗口之后剩余的行数。 */
  remainingLines?: number;
  /** 当前窗口之后仍有内容时为 true。 */
  hasMore?: boolean;
}

export interface FileStatInput {
  path: string;
}

export interface FileStatResult {
  path: string;
  absolutePath: string;
  exists: boolean;
  kind: "file" | "directory" | "missing" | "other";
  sizeBytes: number;
  estimatedTokens: Nullable<number>;
  lineCount: Nullable<number>;
  isBinary: boolean;
  readableText: boolean;
  mtimeMs: Nullable<number>;
  revision: Nullable<string>;
  /** 文本文件推荐的安全首次读取窗口。 */
  recommendedRead: Nullable<{
    path: string;
    range: { startLine: number; endLine: number };
  }>;
  warnings: string[];
}

/** list 操作返回的条目。 */
export interface FileListEntry {
  path: string;
  type: "file" | "directory";
}

export interface SearchInput {
  /** 默认按字面量文本搜索；regex 为 true 时按正则解释。 */
  query: string;
  root?: string;
  include?: string[];
  exclude?: string[];
  /** 默认在工作区根目录为 true；当 root 显式指向子树时为 false。 */
  excludeGitignored?: boolean;
  maxResults?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  /** 为 false 时即使策略启用 ripgrep 也跳过它。 */
  useRipgrep?: boolean;
}

export interface SearchHit {
  path: string;
  /** 生成该命中时观察到的 revision。 */
  revision: string;
  score: number;
  kind: "text" | "symbol" | "file" | "metadata";
  range?: Range;
  snippet?: string;
  adapterId: string;
  /** 搜索片段来自项目内容，默认应保持不可信。 */
  trust: TrustLabel;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** 扫描到更多候选但被 maxResults 截断时为 true。 */
  truncated?: boolean;
  /** 产生命中的后端，用于诊断。 */
  backend?: "ripgrep" | "adapters";
  /** 已扫描文件数（仅 adapter 后端，best-effort）。 */
  scannedFiles?: number;
  /** 搜索后端的非致命诊断，例如 timeout 导致结果不完整。 */
  diagnostics?: string[];
  /** 命令型后端暴露给宿主处理的工具需求。 */
  toolRequirements?: CommandToolRequirement[];
}

export interface ObserveResult extends ProjectSnapshot {}
