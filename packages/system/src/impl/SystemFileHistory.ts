/**
 * 文件版本历史：`SystemFileHistory`。接口 `SystemFileHistoryApi` 在本文件的类上方。
 * 只在内存里，随进程消失；持久化的本地历史是宿主的事。
 */

import { isEmpty, toNullable } from '@velaros-ai/core'

import type { SystemFileSnapshot } from '../types/files.js'
import { fileVersionOf } from '../utils/text-file.js'

/** 每个文件最多留几份。 */
const MaxSnapshotsPerFile = 10
/** 单份最大字节数，再大不留。 */
const MaxSnapshotBytes = 2 * 1024 * 1024
/** 全部历史加起来的上限，超了从最早的删起。 */
const MaxHistoryBytes = 64 * 1024 * 1024

/**
 * 文件版本历史：每次改动前把原内容留一份，供召回旧状态和回滚。只在内存里，每个文件留最近 10 份，单份不超过 2 MB，总量不超过 64 MB，超了从最早的删起。
 *
 * 实现是 `SystemFileHistory`，文件操作持有一份。
 */
export interface SystemFileHistoryApi {
  /** 留下一个文件此刻的原始字节，返回它的版本号（内容哈希）；同样的内容再留一次不重复占地方。太大留不下时返回 null。 */
  remember(path: string, buffer: Buffer): Nullable<string>
  /** 取某个文件留下的某个版本；没留过或已经被挤掉时返回 null。 */
  recall(path: string, version: string): Nullable<SystemFileSnapshot>
}

export class SystemFileHistory implements SystemFileHistoryApi {
  private readonly snapshotsByPath = new Map<string, SystemFileSnapshot[]>()
  private totalBytes = 0

  public remember(path: string, buffer: Buffer): Nullable<string> {
    if (buffer.byteLength > MaxSnapshotBytes) return null
    const version = fileVersionOf(buffer)
    const snapshots = this.snapshotsByPath.get(path) ?? []
    const existing = snapshots.find((snapshot) => snapshot.version === version)
    if (existing) {
      existing.savedAt = Date.now()
      return version
    }
    snapshots.push({ version, buffer, savedAt: Date.now() })
    this.snapshotsByPath.set(path, snapshots)
    this.totalBytes += buffer.byteLength
    while (snapshots.length > MaxSnapshotsPerFile) this.drop(path, snapshots, 0)
    this.trimToBudget()
    return version
  }

  public recall(path: string, version: string): Nullable<SystemFileSnapshot> {
    return toNullable(this.snapshotsByPath.get(path)?.find((snapshot) => snapshot.version === version))
  }

  /** 总量超预算时，从所有文件里最早留下的那份开始删。 */
  private trimToBudget(): void {
    while (this.totalBytes > MaxHistoryBytes) {
      let oldestPath: Nullable<string> = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [path, snapshots] of this.snapshotsByPath) {
        const first = snapshots[0]
        if (first && first.savedAt < oldestAt) {
          oldestAt = first.savedAt
          oldestPath = path
        }
      }
      if (!oldestPath) return
      this.drop(oldestPath, this.snapshotsByPath.get(oldestPath) ?? [], 0)
    }
  }

  /** 删掉某个文件的第 index 份，账目同步减；删空了就把这个文件从表里去掉。 */
  private drop(path: string, snapshots: SystemFileSnapshot[], index: number): void {
    const [removed] = snapshots.splice(index, 1)
    if (removed) this.totalBytes -= removed.buffer.byteLength
    if (isEmpty(snapshots)) this.snapshotsByPath.delete(path)
  }
}
