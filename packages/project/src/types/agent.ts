import type { ApprovalPort,FileContextCarrier } from '@velaros-ai/agent/tool-contract'

import type { ProjectToolApi } from '../contract/requires.js'

import type { AgentProjectPreparedPatch } from './agent-port.js'
import type { ObserveInput } from './io.js'

export interface PathEffect {
  first: AgentProjectPreparedPatch
  last: AgentProjectPreparedPatch
  existedBefore: boolean
  existsAfter: boolean
}

export interface ListCursor {
  query: ObserveInput
  fingerprint: string
  offset: number
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

export interface ProjectFileContextCarrier extends FileContextCarrier {
  project: Pick<ProjectToolApi, 'getRootPath' | 'kernel'>
}

export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number }

export interface EditTarget {
  kind: 'project-edit-target'
  root: string
  path: string
  revision: string
  startLine: number
  endLine: number
}
