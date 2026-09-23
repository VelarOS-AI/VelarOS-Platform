/**
 * 留着能撤回的改动：`FileChanges`，接口 `FileChangesApi` 在本文件的类上方。
 */

import { randomBytes } from 'node:crypto'

import { isUndefined, toNullable } from '@velaros-ai/core'

import { FileLimits } from '../contract/constants.js'
import type { FileChangeEntry, FileChangeRecord } from '../types/edit.js'
import { FileTuning } from '../utils/tuning.js'

/**
 * 每次 edit 记一笔：每个文件改动前的原始字节（新建的记 null）与改动后的版本，`undo` 凭改动号整次撤回。
 * 只在内存里：最多留最近 `FileLimits.undoChanges` 次、原文总量不超过 `FileTuning.changes.totalBytes`，超了从最早的丢起；随进程消失。
 */
export interface FileChangesApi {
  /** 记下一次改动，交回它的号；有文件的原文没留下来时，这次改动记成撤不回。 */
  record(entries: readonly FileChangeEntry[]): FileChangeRecord
  /** 按号取回一次改动；号不对、或者已经太旧被丢掉了，返回 null。 */
  recall(changeId: string): Nullable<FileChangeRecord>
  /** 这次改动已经撤回：再撤一次时如实说，不再动文件。 */
  markUndone(changeId: string): void
}

export class FileChanges implements FileChangesApi {
  private readonly records = new Map<string, FileChangeRecord>()
  private totalBytes = 0
  private sequence = 0

  public record(entries: readonly FileChangeEntry[]): FileChangeRecord {
    this.sequence += 1
    const changeId = `change-${this.sequence}-${randomBytes(3).toString('hex')}`
    const bytes = entries.reduce((sum, entry) => sum + (entry.before?.byteLength ?? 0), 0)
    const record: FileChangeRecord = {
      changeId,
      entries: [...entries],
      bytes,
      undoable: entries.every((entry) => !isUndefined(entry.before)),
      undone: false,
    }
    this.records.set(changeId, record)
    this.totalBytes += bytes
    while (
      this.records.size > FileLimits.undoChanges ||
      (this.records.size > 1 && this.totalBytes > FileTuning.changes.totalBytes)
    ) {
      const [oldest, dropped] = this.records.entries().next().value!
      this.records.delete(oldest)
      this.totalBytes -= dropped.bytes
    }
    return record
  }

  public recall(changeId: string): Nullable<FileChangeRecord> {
    return toNullable(this.records.get(changeId))
  }

  public markUndone(changeId: string): void {
    const record = this.records.get(changeId)
    if (record) record.undone = true
  }
}
