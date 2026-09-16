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

export interface AgentProjectStoredTransaction extends Omit<AgentProjectPreparedTransaction, 'status'> {
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

export interface AgentProjectReadResult {
  redacted?: boolean
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
  truncated?: boolean
  nextStartLine?: number
  remainingLines?: number
  hasMore?: boolean
  continuation?: AgentProjectReadContinuation
  /** 范围被钳制或起始行越界时的说明；此时读取仍算成功。 */
  note?: string
}

export interface AgentProjectReadContinuation {
  path: string
  range: {
    startLine: number
    startColumn?: number
    endLine?: number
    endColumn?: number
  }
  maxChars?: number
  baseRevisions?: Record<string, string>
}

export interface AgentProjectKernelReadResult extends Omit<AgentProjectReadResult, 'continuation'> {
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

/** 一个读不到的路径：码来自合同错误原因表，message 说发生了什么，next 说下一步怎么办。 */
export interface AgentProjectReadIssue {
  path: string
  /** 合同错误原因：路径不存在或是目录、二进制时分别是 TARGET_NOT_FOUND、NOT_SUPPORTED，其余按抛出的码。 */
  code: string
  message: string
  /** 这一条的下一步；没有可照做的下一步时缺省。 */
  next?: string
}

export interface AgentProjectSearchResult {
  query: string
  hits: AgentProjectSearchHit[]
  truncated?: boolean
  toolRequirements?: AgentProjectCommandToolRequirement[]
  nextAction?: string
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

export interface AgentProjectReadRequest {
  path: string | string[]
  range?: {
    startLine?: number
    endLine?: number
    startColumn?: number
    endColumn?: number
    startOffset?: number
    endOffset?: number
  }
  maxBytes?: number
  maxChars?: number
  allowUnbounded?: boolean
  baseRevisions?: Record<string, string>
  trust?: {
    source: 'system' | 'user' | 'project' | 'tool' | 'external'
    trust: 'trusted' | 'untrusted'
  }
}

export interface AgentProjectSearchRequest {
  query: string
  path?: string
  include?: string[]
  exclude?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
}

export interface AgentProjectErrorLike extends Error {
  reason: string
  details?: unknown
  suggestedNextAction?: string
}
