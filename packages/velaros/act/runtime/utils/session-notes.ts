import type { ContextRecord } from '@velaros-ai/context'
import { AppError } from '@velaros-ai/core/error'

import { WorkspaceLimits } from '../../system/contract/constants.js'
import type { WorkspaceEntry } from '../../system/types/workspace.js'
import type { RuntimeNoteRead, WorkspaceNote } from '../types/memory.js'

import { ActRuntimeTuning } from './tuning.js'

/** 目录分页始终使用同一范围，即使会话尚不存在也不接受非法上限。 */
export function notePageLimit(limit?: number): number {
  const bounded = limit ?? ActRuntimeTuning.workspacePage
  if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > WorkspaceLimits.maxPage)
    throw new AppError('VALIDATION', `笔记目录每页 1–${WorkspaceLimits.maxPage} 条`)
  return bounded
}

/** 正文页只核对字符窗口，不读取或建立任何会话事实。 */
export function noteReadRange(input: RuntimeNoteRead): { offset: number; limit: number } {
  const offset = input.offset ?? 0
  const limit = input.limit ?? ActRuntimeTuning.noteReadChars
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ActRuntimeTuning.noteReadChars
  )
    throw new AppError('VALIDATION', '笔记正文分页无效')
  return { offset, limit }
}

/** 目录仅携带稳定键、版本与原文位置，正文按引用独立召回。 */
export function noteEntry(note: WorkspaceNote, record: ContextRecord): WorkspaceEntry {
  return {
    key: note.key,
    revision: note.revision,
    title: note.title,
    ref: record.ref,
    resident: note.resident,
    chars: note.body.length,
  }
}
