import type { PreparedPatch } from '../../types/edit.js'
import { unifiedDiff } from '../../utils/diff.js'
import { id } from '../../utils/id.js'
import { countChangedLines } from '../../utils/text.js'

export function createTextPatch(
  path: string,
  baseRevision: Optional<string>,
  oldContent: Optional<string>,
  newContent: string,
  strategyId: string,
  metadata?: Record<string, unknown>,
): PreparedPatch {
  const diff = unifiedDiff(path, oldContent ?? '', newContent)
  const changedLines = countChangedLines(diff)
  return {
    patchId: id('patch'),
    strategyId,
    path,
    baseRevision,
    oldContent,
    newContent,
    diff,
    changedLines,
    risk: 'low', // 规模不代表风险,统一 low(真正危险在操作层判定)
    metadata,
  }
}
