import type { AgentProjectPreparedPatch } from './agent-port.js'

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

export interface CodeSymbolTarget {
  path: string
  symbol: string
  container?: string
  line?: number
  nodeId?: string
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

/** 一段行范围（闭区间，从 1 起）。 */
export interface LineSpan {
  startLine: number
  endLine: number
}
