import type { ModelMessage } from 'ai'

import type { ModelHistoryRequestPhase,SanitizeModelHistoryOptions } from '../../types/history.js'

import { mapInternalFollowUpsForProvider } from './internal-messages'
import { repairHistoryStructureForProvider } from './repair'
import { sanitizeModelHistory } from './sanitize'
import { assertValidModelHistory } from './validate'

/**
 * 发请求前的最后一道流水线，把一份持久历史变成「供应方一定收得下」的消息数组：
 * ① `sanitizeModelHistory` 逐条清洗（清洗有变动时**就地回写**传入的 `history` 数组，让持久那份也别再带着脏数据）；
 * ② `mapInternalFollowUpsForProvider` 把内部 system 续跑消息改挂 user；
 * ③ `repairHistoryStructureForProvider` 对「即将送校验的确切消息体」做结构自愈（② 之后才可能冒出来的孤儿也在内）；
 * ④ `assertValidModelHistory` 最终校验，不过就抛，这一轮请求根本不发出去。
 *
 * 顺序不能换：③ 必须紧贴 ④，中间再改一次消息体就等于把没校验过的东西发出去；而 ③ 之所以存在，
 * 是因为一次流中止会在持久历史里留下孤儿 tool-result / 缺结果的 tool-call 组，
 * 没有它，此后**每一次** send 都会被 ④ 拦下，会话被永久锁死。
 */
function sanitizeHistoryForProvider(
  history: ModelMessage[],
  phase: ModelHistoryRequestPhase,
  turn: Nullable<number>,
  options: LooseOptional<SanitizeModelHistoryOptions> = undefined
): ModelMessage[] {
  const sanitization = sanitizeModelHistory(history, options || undefined)
  if (sanitization.changedMessages > 0) {
    history.splice(0, history.length, ...sanitization.history)
  }

  const providerMapping = mapInternalFollowUpsForProvider(history)
  // 结构自愈：在最终校验前一刻，对「即将送校验的确切消息体」清理孤儿 tool-result 与
  // 悬空 tool-call 组（含内部续跑映射后可能出现的孤儿），避免一次流中止/异常让此后每次
  // send 都被 assertValidModelHistory 拦下、会话被永久锁死。
  const structureRepair = repairHistoryStructureForProvider(providerMapping.history)
  const providerHistory =
    structureRepair.removedMessages > 0 || structureRepair.changedMessages > 0
      ? structureRepair.history
      : providerMapping.history
  assertValidModelHistory(providerHistory, { phase, turn })
  return providerHistory
}

export { sanitizeHistoryForProvider }
export type { SanitizeModelHistoryOptions }
