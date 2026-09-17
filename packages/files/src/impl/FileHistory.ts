/**
 * 文件版本历史：`FileHistory`。接口 `FileHistoryApi` 在本文件的类上方。
 * 只在内存里，随进程消失；持久化的本地历史是宿主的事。
 */

import { isEmpty, toNullable } from '@velaros-ai/core'

import { FileLimits } from '../contract/constants.js'
import type { FileSnapshot } from '../types/edit.js'
import { fileVersionOf } from '../utils/text-file.js'
import { FileTuning } from '../utils/tuning.js'

/**
 * 文件版本历史：每次改动前把原内容留一份，供读旧版本和回滚。只在内存里，每个文件留最近几份，
 * 单份不超过 `FileLimits.versionedBytes`，总量有上限，超了从最早的删起。
 *
 * 实现是 `FileHistory`，文件操作持有一份。
 */
export interface FileHistoryApi {
  /** 留下一个文件此刻的原始字节，返回它的版本号（内容哈希）；同样的内容再留一次不重复占地方。太大留不下时返回 null。 */
  remember(target: string, buffer: Buffer): Nullable<string>
  /** 取某个文件留下的某个版本；没留过或已经被挤掉时返回 null。 */
  recall(target: string, version: string): Nullable<FileSnapshot>
}

export class FileHistory implements FileHistoryApi {
  private readonly snapshotsByTarget = new Map<string, FileSnapshot[]>()
  private totalBytes = 0

  public remember(target: string, buffer: Buffer): Nullable<string> {
    if (buffer.byteLength > FileLimits.versionedBytes) return null
    const version = fileVersionOf(buffer)
    const snapshots = this.snapshotsByTarget.get(target) ?? []
    const existing = snapshots.find((snapshot) => snapshot.version === version)
    if (existing) {
      existing.savedAt = Date.now()
      return version
    }
    snapshots.push({ version, buffer, savedAt: Date.now() })
    this.snapshotsByTarget.set(target, snapshots)
    this.totalBytes += buffer.byteLength
    while (snapshots.length > FileTuning.history.snapshotsPerFile) this.drop(target, snapshots, 0)
    this.trimToBudget()
    return version
  }

  public recall(target: string, version: string): Nullable<FileSnapshot> {
    return toNullable(this.snapshotsByTarget.get(target)?.find((snapshot) => snapshot.version === version))
  }

  /** 总量超预算时，从所有文件里最早留下的那份开始删。 */
  private trimToBudget(): void {
    while (this.totalBytes > FileTuning.history.totalBytes) {
      let oldestTarget: Nullable<string> = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [target, snapshots] of this.snapshotsByTarget) {
        const first = snapshots[0]
        if (first && first.savedAt < oldestAt) {
          oldestAt = first.savedAt
          oldestTarget = target
        }
      }
      if (!oldestTarget) return
      this.drop(oldestTarget, this.snapshotsByTarget.get(oldestTarget) ?? [], 0)
    }
  }

  /** 删掉某个文件的第 index 份，账目同步减；删空了就把这个文件从表里去掉。 */
  private drop(target: string, snapshots: FileSnapshot[], index: number): void {
    const [removed] = snapshots.splice(index, 1)
    if (removed) this.totalBytes -= removed.buffer.byteLength
    if (isEmpty(snapshots)) this.snapshotsByTarget.delete(target)
  }
}
