import type { ContextFaultEvent, ContextResidencyMigrationEvent } from '../../types/residency.js'
import { stableStringify } from '../../utils/residency/determinism'

/** 事件 → 确定性 JSONL 行（键排序，同事件同字节）。 */
export function formatMigrationEventLine(event: ContextResidencyMigrationEvent): string {
  return stableStringify({ type: 'migration', ...event })
}

/** fault 事件 → 确定性 JSONL 行。 */
export function formatFaultEventLine(event: ContextFaultEvent): string {
  return stableStringify({ type: 'fault', ...event })
}
