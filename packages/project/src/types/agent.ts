import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type { AgentProjectPreparedPatch } from './agent-port.js'
import type { ObserveInput } from './io.js'

export interface PathEffect {
  first: AgentProjectPreparedPatch
  last: AgentProjectPreparedPatch
  existedBefore: boolean
  existsAfter: boolean
}

export interface Waiter {
  write: boolean
  start(): void
  cancel(): void
}

export interface Gate {
  readers: number
  writing: boolean
  queue: Waiter[]
}

export type RecordValue = Record<string, unknown>

export interface ProjectApprovalContext {
  approval: ApprovalPort
  abortSignal: AbortSignal
}

export interface CodeSymbolTarget {
  path: string
  symbol: string
  container?: string
  line?: number
  nodeId?: string
}

export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number }

/** 一段行范围（闭区间，从 1 起）。 */
export interface LineSpan {
  startLine: number
  endLine: number
}

/** list 核对之后的入参：续页时只有 cursor 与 limit，否则是查询条件与 limit。 */
export interface ListQuery {
  cursor?: string
  path?: string
  include?: string[]
  exclude?: string[]
  depth?: number | 'all'
  limit: number
}

/** 列表续页游标里记着的：内核里的查询条件、列出来的指纹、下一页从第几条起。 */
export interface ListCursor {
  query: ObserveInput
  fingerprint: string
  offset: number
}

/** 一个要读的文件：模型给的路径原样（写 issue 用）、定下来的相对路径、行范围、续读时的基准版本。 */
export interface ReadRequest {
  requested: string
  path?: string
  range?: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }
  baseRevision?: string
}
