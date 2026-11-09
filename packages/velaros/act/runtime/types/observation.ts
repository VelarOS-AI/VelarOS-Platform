import type { ContextRef } from '@velaros-ai/context'

import type { ScriptControlReceipt } from './runtime.js'

/** 仅由 observe 选择下一帧的小型历史目录或局部原文；会话归属由宿主绑定。 */
export type ObservationHistoryRequest =
  | { readonly kind: 'list'; readonly cursor?: string; readonly limit?: number }
  | {
      readonly kind: 'read'
      readonly snapshotId: string
      readonly pointer?: string
      readonly offset?: number
      readonly limit?: number
    }

/** 不含快照正文的稳定目录项。 */
export interface ObservationSnapshotSummary {
  readonly snapshotId: string
  readonly sourceRef: string
  readonly revision: number
  readonly observedAt: string
  readonly fingerprint: string
  readonly chars: number
  readonly available: boolean
}

/** 历史选择的真实控制回执；正文只在下一帧的动态区交付。 */
export interface ObservationHistorySelectionReceipt extends ScriptControlReceipt {
  readonly status: 'selected'
  readonly selectionRef: string
  readonly effective: 'next-model-turn'
  readonly executed: false
}

/** 有界目录；预算不足时可少于 limit，使用 nextCursor 继续。 */
export interface ObservationHistoryListing {
  readonly kind: 'list'
  readonly entries: readonly ObservationSnapshotSummary[]
  readonly nextCursor: Nullable<string>
}

/** 一份历史观察的显式局部正文；字符范围按 UTF-16 计算。 */
export interface ObservationHistoryPage {
  readonly kind: 'read'
  readonly snapshot: ObservationSnapshotSummary
  readonly pointer: string
  readonly text: string
  readonly offset: number
  readonly totalChars: number
  readonly nextOffset: Nullable<number>
}

/** 已选择的历史材料失效时如实交付状态，不回退旧正文。 */
export type ObservationHistoryResult =
  | ObservationHistoryListing
  | ObservationHistoryPage
  | { readonly kind: 'unavailable'; readonly snapshotId?: string; readonly reason: string }

/** 当前历史链的有界头；完整目录沿已有不可变会话记录分页读取。 */
export interface ObservationHistoryHead {
  readonly snapshotId: string
  readonly sourceRef: string
  readonly revision: number
  readonly fingerprint: string
  readonly scopeFingerprint: string
}

/** 原始正文沿现有会话引用定位，不复制到观察目录。 */
export type ObservationContentLocator =
  | { readonly kind: 'capture'; readonly captureRef: ContextRef; readonly invocationId: string }
  | { readonly kind: 'result'; readonly resultRef: ContextRef }

/** 同值内容的单一引用；指纹不含采集时间、执行身份或成本。 */
export interface ObservationSnapshotContent {
  readonly fingerprint: string
  readonly locator: ObservationContentLocator
  readonly chars: number
}

/** 一次真实变化；回到旧内容仍保存本次变化时间。 */
export interface ObservationSnapshotTransition {
  readonly sourceRef: ContextRef
  readonly contentRef: ContextRef
  readonly captureRef?: ContextRef
  readonly resultRef?: ContextRef
  readonly revision: number
  readonly observedAt: string
  readonly scopeFingerprint: string
}

/** 独立动态交付的持久选择与原生往返，不包含正文副本。 */
export interface ObservationDynamicState {
  /** 待交付选择绑定接受时的任务与授权水位，迟到写入不能借新任务的序号续命。 */
  readonly pendingDynamicOwner?: string
  readonly observationHistoryHead?: ObservationHistoryHead
  readonly pendingObservationHistory?: {
    readonly selectionRef: string
    readonly request: ObservationHistoryRequest
  }
  readonly pendingDynamicExchanges?: readonly ContextRef[]
  readonly pendingDynamicDelivery?: {
    readonly id: string
    readonly selectionRef?: string
    readonly exchanges: readonly ContextRef[]
  }
}
