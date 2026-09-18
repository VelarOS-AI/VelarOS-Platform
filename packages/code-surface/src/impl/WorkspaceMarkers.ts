/**
 * 工作区标记：`WorkspaceMarkers`，接口 `WorkspaceMarkersApi` 在本文件的类上方；有工作区的时间线建一个。
 *
 * 扫一遍工作区，给每个文件算内容哈希，拼成只含哈希的目录树；树根的哈希就是这一刻的标记。
 * 被 .gitignore 忽略的、按名字默认跳过的目录（.git、node_modules、构建产物……）不算进去，时间线自己的目录也不算；
 * 符号链接不跟进去，记它指向哪。大小、修改时间、inode 都没变的文件不重读，哈希从 stat 缓存里取。
 * 目录节点存进时间线（同样的节点只存一次），文件内容一个字都不存。
 */

import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { isEmpty, isUndefined } from '@velaros-ai/core'
import { createIgnorePolicy } from '@velaros-ai/path-rules'
import { DiscoverySkippedDirectoryNames } from '@velaros-ai/path-rules/contracts'

import type { ScriptFileChange } from '../types/code-surface.js'
import type { MarkerStatEntry, WorkspaceScan } from '../types/timeline.js'
import { buildMarkerTree, diffFileMaps, diffMarkerTrees, hashWorkspaceFile, markerFiles, MarkerSkippedFileNames } from '../utils/markers.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { TimelineStorageApi } from './TimelineStorage.js'

/** 一个工作区的标记：扫描、比较、取出某个标记下的文件表。 */
export interface WorkspaceMarkersApi {
  /** 扫一遍：交回标记与每个文件的哈希，目录节点存进时间线。文件多过上限时交回 undefined，这一次不打标记。 */
  scan(signal?: AbortSignal): Promise<Optional<WorkspaceScan>>
  /** 两个标记之间改了哪些文件，按路径排；一边没有标记时另一边的文件全算新增或删除。 */
  diff(from: Optional<string>, to: Optional<string>): Promise<ScriptFileChange[]>
  /** 一个标记下的全部文件：相对路径 → 内容哈希。 */
  files(marker: string): Promise<ReadonlyMap<string, string>>
}

export class WorkspaceMarkers implements WorkspaceMarkersApi {
  /** 扫描时按名字就跳过的目录。 */
  private static readonly SkippedDirectories: ReadonlySet<string> = new Set(DiscoverySkippedDirectoryNames)

  /** stat 缓存：相对路径 → 上次算哈希时的大小、修改时间、inode 与哈希。头一次扫描时从时间线读。 */
  private cache: Optional<Map<string, MarkerStatEntry>>
  /** 最近几次扫描的文件表：比较刚扫过的两个标记时不用去读节点。 */
  private readonly recent = new Map<string, ReadonlyMap<string, string>>()

  /** root 是工作区根目录；节点与 stat 缓存存进 storage；exclude 是时间线自己的目录，在工作区里面时跳过它。 */
  public constructor(
    private readonly root: string,
    private readonly storage: TimelineStorageApi,
    private readonly exclude: string,
  ) {}

  public async scan(signal?: AbortSignal): Promise<Optional<WorkspaceScan>> {
    const listed = await this.list(signal)
    if (isUndefined(listed)) return undefined
    const cache = await this.statCache()
    const fresh = new Map<string, MarkerStatEntry>()
    const files = new Map<string, string>()
    let rehashed = false
    for (const path of listed) {
      signal?.throwIfAborted()
      const absolute = join(this.root, path)
      const info = await lstat(absolute).catch(
        // arch-guard:silent-catch-ok 列出来之后又被删掉的：当它不在，这一刻的标记里本来就没有它。
        () => undefined,
      )
      if (isUndefined(info)) continue
      const cached = cache.get(path)
      const unchanged = cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ino === info.ino
      const hash = unchanged ? cached.hash : await hashWorkspaceFile(absolute, info).catch(
        // arch-guard:silent-catch-ok 读不了的文件（刚被删、没权限）不进标记：和它不在一样，下一次扫描照样重试。
        () => undefined,
      )
      if (isUndefined(hash)) continue
      if (!unchanged) rehashed = true
      fresh.set(path, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, hash })
      files.set(path, hash)
    }
    if (rehashed || fresh.size !== cache.size) {
      this.cache = fresh
      await this.storage.writeStatCache({ root: this.root, files: Object.fromEntries(fresh) })
    }
    const { marker, nodes } = buildMarkerTree(files)
    for (const text of nodes.values()) await this.storage.put(text)
    this.remember(marker, files)
    return { marker, files }
  }

  public async diff(from: Optional<string>, to: Optional<string>): Promise<ScriptFileChange[]> {
    if (from === to) return []
    const before = isUndefined(from) ? undefined : this.recent.get(from)
    const after = isUndefined(to) ? undefined : this.recent.get(to)
    if (before && after) return diffFileMaps(before, after)
    return diffMarkerTrees(from, to, (hash) => this.storage.get(hash))
  }

  public async files(marker: string): Promise<ReadonlyMap<string, string>> {
    const known = this.recent.get(marker)
    if (known) return known
    const files = await markerFiles(marker, (hash) => this.storage.get(hash))
    this.remember(marker, files)
    return files
  }

  /** 记住最近两次扫描的文件表，更早的丢掉。 */
  private remember(marker: string, files: ReadonlyMap<string, string>): void {
    this.recent.delete(marker)
    this.recent.set(marker, files)
    while (this.recent.size > 2) {
      const oldest = this.recent.keys().next().value
      if (isUndefined(oldest)) break
      this.recent.delete(oldest)
    }
  }

  /** stat 缓存：头一次从时间线读，根目录对不上就当没有。 */
  private async statCache(): Promise<Map<string, MarkerStatEntry>> {
    if (isUndefined(this.cache)) {
      const stored = await this.storage.readStatCache()
      this.cache = stored?.root === this.root ? new Map(Object.entries(stored.files)) : new Map()
    }
    return this.cache
  }

  /**
   * 列出要打标记的文件（相对根目录、用 / 分段），一层一层往下走：按名字跳过默认目录，按各级 .gitignore 跳过被忽略的。
   * 文件多过上限时交回 undefined。
   */
  private async list(signal?: AbortSignal): Promise<Optional<string[]>> {
    const policy = createIgnorePolicy(this.root, {})
    const files: string[] = []
    let level: Array<{ absolute: string; relative: string }> = [{ absolute: this.root, relative: '' }]
    while (!isEmpty(level)) {
      const next: Array<{ absolute: string; relative: string }> = []
      for (const directory of level) {
        signal?.throwIfAborted()
        const entries: Dirent[] = await readdir(directory.absolute, { withFileTypes: true }).catch(() => [])
        const candidates = entries
          .filter((entry) => (entry.isDirectory() ? !WorkspaceMarkers.SkippedDirectories.has(entry.name) : !MarkerSkippedFileNames.has(entry.name)))
          .map((entry) => ({
            entry,
            absolutePath: join(directory.absolute, entry.name),
            isDirectory: entry.isDirectory(),
            relative: directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
          }))
          .filter((candidate) => candidate.absolutePath !== this.exclude)
        const ignored = await policy.ignoredAmong(candidates)
        for (const candidate of candidates) {
          if (ignored.has(candidate.absolutePath)) continue
          if (candidate.isDirectory) next.push({ absolute: candidate.absolutePath, relative: candidate.relative })
          else if (candidate.entry.isFile() || candidate.entry.isSymbolicLink()) files.push(candidate.relative)
        }
        if (files.length > CodeSurfaceTuning.markerFiles) return undefined
      }
      level = next
    }
    return files
  }
}

