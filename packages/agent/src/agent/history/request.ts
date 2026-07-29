import type { ModelMessage } from 'ai'

import type { ChatContextEvidenceRecord } from '@velaros-ai/core/types'

import { repairHistoryStructureForProvider } from './compaction'
import { mapInternalFollowUpsForProvider } from './internalMessages'
import {
  sanitizeModelHistory,
  type SanitizeModelHistoryOptions,
} from './sanitize'
import { assertValidModelHistory } from './validate'

type ModelHistoryRequestPhase = 'stream' | 'query'

interface AgentHistoryToolContext {
  /** Opaque execution-session state carried through generic history preparation. */
  codingSession: unknown
  sessionId?: string
  evidenceLedger?: readonly ChatContextEvidenceRecord[]
  /** Context OS 派生视图已激活时，跳过 conversation 级 fold，避免与 view compaction 重复。 */
  contextViewActive?: boolean
}

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
export type { ModelHistoryRequestPhase, SanitizeModelHistoryOptions }
export type { AgentHistoryToolContext }
