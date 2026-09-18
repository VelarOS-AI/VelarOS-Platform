/**
 * 时间线落盘：`TimelineStorage`，接口 `TimelineStorageApi` 在本文件的类上方；时间线（`ScriptTimeline`）按目录建一个。
 *
 * 一个目录里三样东西：
 * - `objects/`：按 sha256 寻址的文字——代码、参数、结果、目录节点，同样的内容只存一份；
 * - `journal.jsonl`：日志，每次调用开头一行、每一步一行，只往后追加（清理时整份重写）；
 * - `stat-cache.json`：打标记用的 stat 缓存，大小、修改时间、inode 都没变的文件不重算哈希。
 * 工作区文件的内容从不进这里。
 */

import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { MarkerStatCache, TimelineRecord } from '../types/timeline.js'
import { writeFileAtomic } from '../utils/fs.js'
import { sha256Text } from '../utils/markers.js'
import { isMarkerStatCache, isTimelineRecord } from '../utils/timeline.js'

/** 一条时间线的落盘：存取对象、追加与重写日志、读写 stat 缓存。 */
export interface TimelineStorageApi {
  /** 存一段文字，交回它的 sha256；同样的内容只存一份。 */
  put(text: string): Promise<string>
  /** 按哈希取回；从没存过或者已经清掉时交回 undefined。 */
  get(hash: string): Promise<Optional<string>>
  /** 读出整份日志；坏掉的行（写到一半断电）跳过。没有日志时交回空的。 */
  readJournal(): Promise<TimelineRecord[]>
  /** 往日志末尾追加一行；同一个实例里的追加按调用顺序落盘。 */
  append(record: TimelineRecord): Promise<void>
  /** 整份重写日志（清理之后）：先写临时文件再改名，断在中途也不会留下半份。 */
  rewriteJournal(records: readonly TimelineRecord[]): Promise<void>
  /** 读 stat 缓存；没有或者坏了交回 undefined。 */
  readStatCache(): Promise<Optional<MarkerStatCache>>
  /** 写 stat 缓存。 */
  writeStatCache(cache: MarkerStatCache): Promise<void>
  /** 存着的全部对象：哈希 → 字节数。 */
  inventory(): Promise<ReadonlyMap<string, number>>
  /** 对象一共占多少字节：头一次问时数一遍，之后跟着存、删增减。 */
  size(): Promise<number>
  /** 删掉这些对象；本来就不在的不算错。 */
  remove(hashes: Iterable<string>): Promise<void>
}

export class TimelineStorage implements TimelineStorageApi {
  /** 日志文件名。 */
  private static readonly JournalFile = 'journal.jsonl'
  /** stat 缓存文件名。 */
  private static readonly StatCacheFile = 'stat-cache.json'
  /** 对象目录名。 */
  private static readonly ObjectsDirectory = 'objects'

  /** 已经知道存着的对象：省掉一次次去磁盘上核对。 */
  private readonly known = new Set<string>()
  /** 追加日志排成一条队，免得两行交错着写。 */
  private tail: Promise<void> = Promise.resolve()
  /** 目录建过没有。 */
  private prepared: Optional<Promise<void>>
  /** 对象一共占多少字节；数过一遍之前是 undefined。 */
  private bytes: Optional<number>

  public constructor(private readonly directory: string) {}

  public async put(text: string): Promise<string> {
    const hash = sha256Text(text)
    if (this.known.has(hash)) return hash
    const path = this.objectPath(hash)
    await mkdir(join(path, '..'), { recursive: true })
    const existing = await stat(path).catch(
      // arch-guard:silent-catch-ok 读不到就是还没存过：接着写一份，写不进去的错照常抛出。
      () => undefined,
    )
    if (isUndefined(existing)) {
      await writeFileAtomic(path, text)
      if (!isUndefined(this.bytes)) this.bytes += Buffer.byteLength(text, 'utf8')
    }
    this.known.add(hash)
    return hash
  }

  public async get(hash: string): Promise<Optional<string>> {
    return readFile(this.objectPath(hash), 'utf8').catch(
      // arch-guard:silent-catch-ok 读不到就是没存过或者被保留上限清掉了：交回 undefined，调用方各自说清楚。
      () => undefined,
    )
  }

  public async readJournal(): Promise<TimelineRecord[]> {
    const text = await readFile(join(this.directory, TimelineStorage.JournalFile), 'utf8').catch(() => '')
    const records: TimelineRecord[] = []
    for (const line of text.split('\n')) {
      if (isEmpty(line.trim())) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isTimelineRecord(parsed)) records.push(parsed)
      } catch {
        // arch-guard:silent-catch-ok 写到一半断电留下的半行：跳过它，前后的记录照样可用。
      }
    }
    return records
  }

  public append(record: TimelineRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    return this.enqueue(async () => {
      await this.prepare()
      await appendFile(join(this.directory, TimelineStorage.JournalFile), line, 'utf8')
    })
  }

  public rewriteJournal(records: readonly TimelineRecord[]): Promise<void> {
    const text = records.map((record) => `${JSON.stringify(record)}\n`).join('')
    return this.enqueue(async () => {
      await this.prepare()
      await writeFileAtomic(join(this.directory, TimelineStorage.JournalFile), text)
    })
  }

  public async readStatCache(): Promise<Optional<MarkerStatCache>> {
    const text = await readFile(join(this.directory, TimelineStorage.StatCacheFile), 'utf8').catch(
      // arch-guard:silent-catch-ok 缓存读不到就当没有：下一次扫描把哈希重算一遍，结果不受影响。
      () => undefined,
    )
    if (isUndefined(text)) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      return isMarkerStatCache(parsed) ? parsed : undefined
    } catch {
      // arch-guard:silent-catch-ok 缓存坏了就当没有：下一次扫描把哈希重算一遍，结果不受影响。
      return undefined
    }
  }

  public async writeStatCache(cache: MarkerStatCache): Promise<void> {
    await this.prepare()
    await writeFileAtomic(join(this.directory, TimelineStorage.StatCacheFile), JSON.stringify(cache))
  }

  public async inventory(): Promise<ReadonlyMap<string, number>> {
    const sizes = new Map<string, number>()
    const root = join(this.directory, TimelineStorage.ObjectsDirectory)
    const shards = await readdir(root).catch(() => [])
    for (const shard of shards) {
      const names = await readdir(join(root, shard)).catch(() => [])
      for (const name of names) {
        // 写到一半的临时文件不算对象。
        if (name.includes('.')) continue
        const info = await stat(join(root, shard, name)).catch(
          // arch-guard:silent-catch-ok 数的时候刚被删掉的对象：不算它。
          () => undefined,
        )
        if (isUndefined(info)) continue
        sizes.set(`${shard}${name}`, info.size)
        this.known.add(`${shard}${name}`)
      }
    }
    return sizes
  }

  public async size(): Promise<number> {
    if (isUndefined(this.bytes)) {
      let total = 0
      for (const bytes of (await this.inventory()).values()) total += bytes
      this.bytes = total
    }
    return this.bytes
  }

  public async remove(hashes: Iterable<string>): Promise<void> {
    for (const hash of hashes) {
      const path = this.objectPath(hash)
      const info = await stat(path).catch(
        // arch-guard:silent-catch-ok 本来就不在的对象：删它不算错，也不用扣字节数。
        () => undefined,
      )
      this.known.delete(hash)
      await rm(path, { force: true })
      if (!isUndefined(info) && !isUndefined(this.bytes)) this.bytes -= info.size
    }
  }

  /** 对象落在哪：前两位做子目录，免得一个目录里几万个文件。 */
  private objectPath(hash: string): string {
    return join(this.directory, TimelineStorage.ObjectsDirectory, hash.slice(0, 2), hash.slice(2))
  }

  /** 排进日志的写队列：前一次写失败不连累后面的，失败只报给那一次的调用方。 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** 建好时间线目录（只建一次）。 */
  private prepare(): Promise<void> {
    this.prepared ??= mkdir(this.directory, { recursive: true }).then(() => undefined)
    return this.prepared
  }
}

