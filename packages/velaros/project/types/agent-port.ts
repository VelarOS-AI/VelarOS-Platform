import type { ProjectTransactionStatus } from './transaction.js'

export interface AgentProjectCommandToolRequirement {
  kind: string
  command: string
  reason?: string
}

export interface AgentProjectPreparedPatch {
  /** 提交快照归档使用内核实际补丁内容，避免写入后重读时外部变更吞掉中间版本。 */
  oldContent?: string
  newContent?: string
  path: string
  baseRevision?: string
  diff: string
  changedLines: number
  /** 策略写入的补丁说明；Agent 边界只读取其中给模型看的 matchNote。 */
  metadata?: Readonly<Record<string, unknown>>
}

export interface AgentProjectPreparedTransaction {
  transactionId: string
  status: 'prepared'
  patches: AgentProjectPreparedPatch[]
  changedFiles: string[]
  diff: string
  changedLines: number
  risk: 'low' | 'medium' | 'high'
  createdAt: number
  /** 计划元数据原样保存在事务上，例如编码转换的 recode 回执。 */
  metadata?: Record<string, unknown>
}

export interface AgentProjectStoredTransaction extends Omit<
  AgentProjectPreparedTransaction,
  'status'
> {
  status: ProjectTransactionStatus
  appliedAt?: number
}

export interface AgentProjectApplyResult {
  transactionId: string
  changedFiles: string[]
  oldRevisions: Record<string, string>
  newRevisions: Record<string, string>
  rebasedFiles?: string[]
  gitTrackedFiles?: string[]
  gitUntrackedFiles?: string[]
}

export interface AgentProjectFileSnapshot {
  path: string
  exists: boolean
  isDirectory: boolean
  isBinary: boolean
  revision?: string
}

/** 内核读到的一个文件在 Agent 边界上的样子：快照只留定位要的字段，正文只放一份。 */
export interface AgentProjectReadResult {
  snapshot: AgentProjectFileSnapshot
  content?: string
  range?: {
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
    startOffset?: number
    endOffset?: number
  }
  totalLines?: number
  /** 要的那一段没读全：字符上限不够装下它。 */
  truncated?: boolean
  /** 范围被钳制或起始行越界时的说明；此时读取仍算成功。 */
  note?: string
}

/** 内核端口的 read 交回的：Agent 边界上的那些，加上后面还有没有内容、从哪儿接着读（给内核的其它调用方用，Agent 边界不续读）。 */
export interface AgentProjectKernelReadResult extends AgentProjectReadResult {
  nextStartLine?: number
  remainingLines?: number
  hasMore?: boolean
  continuation?: {
    path: string
    range?: {
      startLine?: number
      endLine?: number
      startColumn?: number
      endColumn?: number
    }
    maxChars?: number
    baseRevision?: string
  }
}

/** 内核端口的 search 交回的：命中、有没有收全（没收全时 diagnostics 可能说明为什么，比如超时），缺搜索命令时的工具需求。 */
export interface AgentProjectSearchResult {
  query: string
  hits: AgentProjectSearchHit[]
  truncated?: boolean
  diagnostics?: string[]
  toolRequirements?: AgentProjectCommandToolRequirement[]
}

export interface AgentProjectSearchHit {
  path: string
  revision?: string
  range?: {
    startLine: number
    startColumn?: number
    endLine: number
    endColumn?: number
  }
  snippet?: string
}

/** Agent 边界读一个文件：相对项目根的路径，可带整行范围、钉住的版本（文件变了就拒绝）与字符上限。 */
export interface AgentProjectReadRequest {
  path: string
  range?: { startLine: number; endLine: number }
  baseRevision?: string
  maxChars?: number
}

/** Agent 边界搜一次源码：条件都已核对并换成相对项目根的写法。 */
export interface AgentProjectSearchRequest {
  query: string
  path?: string
  include?: string[]
  exclude?: string[]
  regex?: boolean
  caseSensitive?: boolean
}

export interface AgentProjectErrorLike extends Error {
  reason: string
  details?: unknown
  suggestedNextAction?: string
}
