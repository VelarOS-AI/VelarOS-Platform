import { isPresent } from '@velaros-ai/core'

import type { ChatContextRetrievalIndexSourceFingerprint } from '../../types/agent.js'
import type { ChatContextRetrievalIndexSnapshot } from '../../types/retrieval.js'

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

function isBlankFingerprint(fingerprint: ChatContextRetrievalIndexSourceFingerprint): boolean {
  return (
    !isPresent(fingerprint.stateMtimeMs) &&
    !isPresent(fingerprint.payloadMtimeMs) &&
    !isPresent(fingerprint.payloadFingerprint)
  )
}

export { ChatContextRetrievalIndexVersion, contextRetrievalFingerprintIsComparable, contextRetrievalFingerprintsEqual }
