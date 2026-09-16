// ProviderTurnEventReducer 用到的纯函数（不碰实例状态）。
import { toNullable } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProviderRequestFingerprint, ProviderTurnRequestSnapshot, ProviderTurnToolSnapshot } from '../../types/records.js'
import type { CompleteProviderTurnSnapshotOptions, CompleteProviderTurnSnapshotResult, EmitCompletedProviderTurnSnapshotInput, ProviderTurnRecorder } from '../../types/records.js'

/** 浅拷贝一条工具快照，避免读侧持有的快照被后续改动带走。 */
export function cloneTool(tool: ProviderTurnToolSnapshot): ProviderTurnToolSnapshot {
  return { ...tool }
}

/**
 * 请求快照的**唯一构造器**（事件入账与快照外发共用）。
 *
 * 全部可选字段一律浅拷贝而非引用透传：快照要在回合收敛后仍可被读侧安全持有，
 * 引用透传会让调用方后续改自己的对象时把已发出的快照一起改掉。
 * 出核统一 `Nullable`（`toNullable`），入参两种缺席形态都收——归一只在这一处发生（§1.5）。
 */
export function buildRequestSnapshot(source: {
  availableToolNames: readonly string[]
  toolChoiceName?: LooseOptional<string>
  requestFingerprint?: ProviderRequestFingerprint
  toolSchemaChars?: Record<string, number>
  toolSchemaHashes?: Record<string, string>
  contextUsage?: ProviderTurnRequestSnapshot['contextUsage']
}): ProviderTurnRequestSnapshot {
  const snapshot: ProviderTurnRequestSnapshot = {
    availableToolNames: [...source.availableToolNames],
    toolChoiceName: toNullable(source.toolChoiceName),
  }
  if (source.requestFingerprint) snapshot.requestFingerprint = { ...source.requestFingerprint }
  if (source.toolSchemaChars) snapshot.toolSchemaChars = { ...source.toolSchemaChars }
  if (source.toolSchemaHashes) snapshot.toolSchemaHashes = { ...source.toolSchemaHashes }
  if (source.contextUsage) snapshot.contextUsage = { ...source.contextUsage }
  return snapshot
}

/** 回合被中止时给还停在 pending 的工具调用写一条诊断：说明它们是被打断而非工具出错。 */
export function buildInterruptedToolsDiagnostic(
  toolCallIds: string[]
): { code: string; message: string; details?: Record<string, unknown> } {
  return {
    code: 'provider-turn-tools-interrupted',
    message: `本回合被中止时还有 ${toolCallIds.length} 个 provider 工具调用停在 pending，已按「被打断」收尾；它们的真实结果不会再回来，快照里这几条的失败原因不代表工具本身出错。`,
    details: { toolCallIds },
  }
}

/** 收敛一次 provider 回合的快照；归约器报错时按结果里的 error 上抛给调用方判断。 */
export function completeProviderTurnSnapshot(
  reducer: ProviderTurnRecorder,
  options: CompleteProviderTurnSnapshotOptions = {}
): CompleteProviderTurnSnapshotResult {
  try {
    return {
      snapshot: reducer.complete(),
      interruptedToolCallIds: [],
    }
  } catch (error) {
    const interruptedToolCallIds = reducer.pendingToolCallIds()
    if (!options.interruptPendingTools || isEmpty(interruptedToolCallIds)) {
      throw error
    }

    return {
      snapshot: reducer.completeWithInterruptedPendingTools(options.interruptedToolError),
      interruptedToolCallIds,
    }
  }
}

/**
 * provider 回合快照的**单源发射器**：把 reducer 收敛成 {@link ProviderTurnSnapshot} 并交给 onSnapshot。
 * 此前 StreamTurn / QueryTurn 各抄一份逐字相同的收敛+发射+吞错逻辑（三胞胎之二），此处收口——
 * pending-tools 中断诊断与快照失败隔离（快照 bug 绝不冒泡进回合主路）一处表达，连告警文案也收敛为
 * 单源。返回是否真的发出了快照。
 */
export function emitCompletedProviderTurnSnapshot(
  input: EmitCompletedProviderTurnSnapshotInput
): boolean {
  const { reducer, onSnapshot, log } = input
  if (!reducer || !onSnapshot) return false
  if (
    input.requirePendingTools &&
    isEmpty(reducer.pendingToolCallIds()) &&
    !reducer.hasDiagnostics()
  )
    return false

  try {
    const completion = completeProviderTurnSnapshot(reducer, { interruptPendingTools: true })
    if (!isEmpty(completion.interruptedToolCallIds)) {
      log.warn('provider turn snapshot interrupted pending tools', {
        toolCallIds: completion.interruptedToolCallIds,
      })
    }
    onSnapshot(completion.snapshot)
    return true
  } catch (error) {
    log.warn('provider turn snapshot completion failed', { error: AppError.getMessage(error) })
    return false
  }
}
