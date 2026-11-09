import type { ContextRecordSelection, ContextStorage } from '@velaros-ai/context'
import { isNull, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { WorkspaceEntry } from '../../system/types/workspace.js'
import type {
  RuntimeNoteContent,
  RuntimeNoteRead,
  SessionNotesSnapshot,
  WorkspaceNote,
} from '../types/memory.js'
import { noteEntry, notePageLimit, noteReadRange } from '../utils/session-notes.js'

/** 借用会话原始存储读取当前授权范围内的工作笔记，不建立执行与模型资源。 */
export interface SessionNotesApi {
  /** 读取固定快照，按历史重置与当前任务水位裁剪笔记及其版本。 */
  load(
    signal: AbortSignal,
    selective?: boolean,
    selections?: readonly ContextRecordSelection[]
  ): Promise<SessionNotesSnapshot>
  /** 按稳定键分页读取当前笔记目录，包含已移出驻留窗口的条目。 */
  list(
    input: { after?: string; limit?: number },
    signal: AbortSignal
  ): Promise<{ items: readonly WorkspaceEntry[]; nextAfter: Nullable<string> }>
  /** 按确定版本与原有字符分页读取笔记正文。 */
  readNote(input: RuntimeNoteRead, signal: AbortSignal): Promise<RuntimeNoteContent>
}

/** 当前笔记读取的唯一存储机制，与执行会话和控制租约共用任务授权边界。 */
export class SessionNotes implements SessionNotesApi {
  public constructor(
    private readonly id: string,
    private readonly storage: ContextStorage
  ) {}

  private async snapshot(signal: AbortSignal, selections?: readonly ContextRecordSelection[]) {
    signal.throwIfAborted()
    const selected = selections ? await this.storage.selectSnapshot(this.id, selections) : undefined
    const snapshot = selections
      ? selected
        ? { ...selected.metadata, records: selected.records }
        : null
      : await this.storage.load(this.id)
    signal.throwIfAborted()
    return snapshot
  }

  public async load(
    signal: AbortSignal,
    selective = false,
    selections: readonly ContextRecordSelection[] = []
  ): Promise<SessionNotesSnapshot> {
    const snapshot = await this.snapshot(
      signal,
      selective
        ? [
            { title: 'search:history-reset', latest: true },
            { titlePrefix: 'workspace:note:', latestPerTitle: true },
            ...selections,
          ]
        : undefined
    )
    const reset = Math.max(
      snapshot?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ??
        0,
      snapshot?.task?.startedSequence ?? 0
    )
    const records = [
      ...new Map(
        (snapshot?.records ?? [])
          .filter((record) => record.sequence > reset && record.title.startsWith('workspace:note:'))
          .map((record) => [record.title, record])
      ).values(),
    ]
    const notes = []
    for (const record of records) {
      signal.throwIfAborted()
      const body = await this.storage.get(this.id, record.objectId)
      if (isNull(body)) throw new AppError('NOT_FOUND', '工作笔记原文缺失')
      notes.push({ record, note: JSON.parse(body) as WorkspaceNote })
    }
    return { snapshot, reset, notes }
  }

  public async list(
    input: { after?: string; limit?: number },
    signal: AbortSignal
  ): Promise<{ items: readonly WorkspaceEntry[]; nextAfter: Nullable<string> }> {
    const limit = notePageLimit(input.limit)
    const { notes } = await this.load(signal, true)
    const items = notes
      .map((item) => noteEntry(item.note, item.record))
      .filter((item) => isUndefined(input.after) || item.key > input.after)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const page = items.slice(0, limit)
    return { items: page, nextAfter: items.length > limit ? page.at(-1)!.key : null }
  }

  public async readNote(input: RuntimeNoteRead, signal: AbortSignal): Promise<RuntimeNoteContent> {
    const { offset, limit } = noteReadRange(input)
    const { notes } = await this.load(signal, true)
    const entry = notes.find((item) => item.note.key === input.key)
    if (!entry) throw new AppError('MEMORY_NOT_FOUND', '工作笔记不存在')
    if (entry.note.revision !== input.revision)
      throw new AppError('WORKSPACE_CONFLICT', '笔记版本已变化，请刷新目录')
    return {
      entry: noteEntry(entry.note, entry.record),
      text: entry.note.body.slice(offset, offset + limit),
      totalChars: entry.note.body.length,
      offset,
    }
  }
}
