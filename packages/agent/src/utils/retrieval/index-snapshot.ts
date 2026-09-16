import { isPresent } from '@velaros-ai/core'

import type { ChatContextRetrievalIndexSourceFingerprint } from '../../types/agent.js'
import type { CachedRetrievalIndex, ChatContextRetrievalIndexSnapshot } from '../../types/retrieval.js'

/** 索引 snapshot schema 版本；与 {@link ContextRetrievalIndexBuilder} 产出一致。 */
const ChatContextRetrievalIndexVersion = 2 satisfies ChatContextRetrievalIndexSnapshot['version']

/**
 * 两份源指纹是否等价（= 索引仍新鲜）。
 *
 * 任一侧三项全空视为**不可比**（返回 false，强制 rebuild）：全空既可能是"会话真没数据"，
 * 也可能是"目录读失败"，两者不可区分时只能选不缓存。宿主与服务层共用这一把尺，
 * 否则磁盘新鲜度与内存缓存新鲜度会在边界情况上分叉。
 */
function contextRetrievalFingerprintsEqual(
  left: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>,
  right: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>
): boolean {
  if (!left || !right) return false
  if (isBlankFingerprint(left) || isBlankFingerprint(right)) return false

  return (
    left.stateMtimeMs === right.stateMtimeMs &&
    left.payloadMtimeMs === right.payloadMtimeMs &&
    left.payloadFingerprint === right.payloadFingerprint
  )
}

/** 指纹是否可作为新鲜度判据（三项全空 = 不可比，见 {@link contextRetrievalFingerprintsEqual}）。 */
function contextRetrievalFingerprintIsComparable(
  fingerprint: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>
): boolean {
  return !!fingerprint && !isBlankFingerprint(fingerprint)
}

/**
 * 判一份源指纹是不是三项（`stateMtimeMs` / `payloadMtimeMs` / `payloadFingerprint`）**全都缺席**。
 * 全空意味着"这份指纹不可比"：它既可能是会话真没数据，也可能是目录读失败，两者分不开，
 * 所以调用方一律按不新鲜处理、强制 rebuild——宁可白建一次索引，也不拿一份可能来自读失败的指纹去判命中。
 * 只要有一项在就返回 false（可比）。
 */
function isBlankFingerprint(fingerprint: ChatContextRetrievalIndexSourceFingerprint): boolean {
  return (
    !isPresent(fingerprint.stateMtimeMs) &&
    !isPresent(fingerprint.payloadMtimeMs) &&
    !isPresent(fingerprint.payloadFingerprint)
  )
}

/**
 * 内存里缓存的这份索引还能不能拿来用：快照自报的 sessionId 得就是要找的这个，schema 版本得是当前这版。
 *
 * 指纹只回答「源变没变」，回答不了「这份快照是谁的、还是不是当前结构」。同一 sessionId 被复用、
 * 或索引 schema 升级后旧条目继续服役，都是零报错的静默错答，所以复用前必须再过这一道。
 */
function isServiceableCachedRetrievalIndex(cached: CachedRetrievalIndex, sessionId: string): boolean {
  return (
    cached.snapshot.sessionId === sessionId &&
    cached.snapshot.version === ChatContextRetrievalIndexVersion
  )
}

export { ChatContextRetrievalIndexVersion, contextRetrievalFingerprintIsComparable, contextRetrievalFingerprintsEqual, isServiceableCachedRetrievalIndex }
