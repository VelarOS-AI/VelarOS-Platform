import type { BrowserPageDriverDownloadItem } from '../contract/requires.js'

import type { BrowserElementTargetHint, BrowserUserActivityKind } from './browser.js'

export interface BrowserTargetRefSession {
  generation: number
  refs: Map<string, BrowserElementTargetHint>
}

export interface StoredBrowserTargetRefs {
  generation: number
  aliases: Map<string, string>
}

export interface BrowserSessionActionOptions {
  /** 排队期间的取消信号：还没轮到就中止时立刻退出排队，不再执行动作。 */
  readonly signal?: AbortSignal
  /** 覆盖 {@link BrowserTuning.session.actionHoldCapMs}；只在调用方确知本动作更短/更长时才传。 */
  readonly holdCapMs?: number
  /** 超时正文里的动作名，便于把死结定位到具体调用点。 */
  readonly label?: string
}

/**
 * 队列名额 —— **把「动作 settle 了」与「名额释放了」拆成两件事**。
 *
 * 这正是本文件的核心判决：上一版拿动作自己的 promise 当队列链，于是
 * 「动作永不 settle」在结构上等价于「会话永久瘫痪」，没有任何一层能插手。
 * 名额独立之后，超时与中止都能在动作还挂着的时候把队伍放行。
 */
export interface BrowserSessionQueueSlot {
  readonly released: Promise<void>
  readonly release: () => void
}

export interface PendingDialogEntry {
  id: string
  sessionId: string
  type: string
  message: Nullable<string>
  title: Nullable<string>
  defaultPromptText: Nullable<string>
  createdAt: number
  resolve: (response: { accept: boolean; promptText: string }) => void
}

export interface PendingDownloadEntry {
  id: string
  sessionId: string
  filename: string
  url: Nullable<string>
  mimeType: string
  totalBytes: number
  item: BrowserPageDriverDownloadItem
  createdAt: number
  settled: boolean
}

export interface PendingPermissionEntry {
  id: string
  sessionId: string
  permission: string
  url: Nullable<string>
  requestingUrl: Nullable<string>
  embeddingOrigin: Nullable<string>
  createdAt: number
  resolve: (granted: boolean) => void
}

export type BrowserUserActivityWaitState = 'waiting' | 'idle'

export interface BrowserUserActivityWaitResult {
  waited: boolean
  waitedMs: number
}

export interface BrowserActivitySessionState {
  lastUserActivityAt: Nullable<number>
  modelActionDepth: number
}

export interface BrowserUserActivityItem {
  kind: BrowserUserActivityKind
  url: Nullable<string>
  occurredAt: number
  detail?: LooseOptional<string>
}

export interface BrowserUserActivitySummary {
  startedAt: number
  endedAt: number
  itemCount: number
  items: BrowserUserActivityItem[]
  text: string
}
