import type { ModelMessage } from 'ai'

import type { ContextPayloadStore } from '../ContextPayloadStore'

/** 文件正文与显示范围绑定同一 revision；列号沿用 Project 的 UTF-16 口径。 */
export interface FileContextRange {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}

export interface FileContextSnapshot {
  workspaceId: string
  path: string
  revision: string
  exists: boolean
  content: string
  redacted?: boolean
  range: FileContextRange
  totalLines: number
  complete: boolean
  /** Non-editable source candidate. A final model projection may mint a view for its displayed subset. */
  viewSource?: string
  presentation?: {
    lines: Array<[number, string]>
    fragments?: Array<{ line: number; columns: [number, number]; text: string }>
    continuation?: unknown
    hasMore?: boolean
  }
}

/** 来源负责项目边界、权限和版本一致性；Agent 不直接访问文件系统。 */
export interface FileContextSource {
  workspaceId: string
  normalizePath(path: string): string
  validateArchive?(snapshot: FileContextSnapshot): Promise<void>
  read(path: string, ranges: readonly FileContextRange[], scopeId?: string): Promise<FileContextSnapshot[]>
  finalizeModelResult?(value: unknown, scopeId: string): Promise<unknown>
}

export interface FileContextCarrier {
  codingSession?: unknown
  fileContextScope?: object
  getCurrentVisibleToolNames?: () => string[]
  sessionId?: string
  contextPayloadStore?: ContextPayloadStore
  abortSignal?: AbortSignal
  toolCallId?: string
}

export interface FileSnapshotArchive extends FileContextSnapshot {
  kind: 'file-snapshot'
  version: 1
  sourceToolCallId?: string
}

/** requested：模型显式读取或修改过的文件；incidental：搜索命中等顺带观察，预算不足时先让位、先淘汰。 */
export type FileContextViewTier = 'requested' | 'incidental'

export interface FileContextView {
  workspaceId: string
  path: string
  sequence: number
  priority: number
  /** 缺省视为 requested。 */
  tier?: FileContextViewTier
  status: 'fresh' | 'dirty' | 'unavailable' | 'deleted'
  ranges: FileContextRange[]
  snapshots: FileContextSnapshot[]
  refs: Array<string | undefined>
  error?: string
}

export interface FileSnapshotRecallInput {
  path?: string
  revision?: string
  ref?: string
  offset?: number
  maxChars?: number
  maxResults?: number
}

export interface FileContextProjection {
  history: ModelMessage[]
  tail: ModelMessage[]
}
