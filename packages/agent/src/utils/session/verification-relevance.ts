/**
 * 「这轮改动值不值得再跑一次验证」怎么从会话快照上读。
 *
 * 哪些文件算代码是空间的知识，不在本包里：跟踪器拿宿主声明的判据（`CodingSessionTrackerOptions.isVerificationRelevantPath`）
 * 数好条数放进快照，这里只负责读，以及读不到时该保守到哪一步。
 */

import { isEmpty } from '@velaros-ai/core'

import type { CodingSessionSnapshot } from '../../types/session.js'

/**
 * 这份快照里有几条改动路径值得验证。快照没带这个数（不是跟踪器出的、或宿主没声明判据）时，
 * 每条改动路径都算——判不出哪些无关紧要，就别替宿主把它们划掉。
 */
export function countVerificationRelevantPaths(snapshot: CodingSessionSnapshot): number {
  return snapshot.verificationRelevantPathCount ?? snapshot.modifiedPaths.length
}

/**
 * 这批改动里是否有值得验证的。**一条路径都没采集到时返回 true**（保守放行）：路径没被采集到
 * 不等于没改代码，此时宁可保留验证失败告警，也不要因为「看不见改了什么」就把告警吞掉。
 */
export function hasVerificationRelevantModifiedPaths(snapshot: CodingSessionSnapshot): boolean {
  return isEmpty(snapshot.modifiedPaths) || countVerificationRelevantPaths(snapshot) > 0
}
