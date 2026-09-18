/**
 * 一个空间的时间线：`ScriptTimeline`，接口 `ScriptTimelineApi` 在本文件的类上方；门按目录开一个，进程里共用。
 *
 * 记下每一次调用、每一步的代码、参数、结果与调过的能力，脚本库（每个路径的各版本）也从这里来；
 * 有工作区时，每一步前后给它打标记，记下这一步改了哪些文件（只有哈希）。
 * 日志读进来之后索引都在内存里；写的时候先落盘再改索引。存的东西超过保留上限时，从最旧的调用清起。
 */

import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { CodeSurfaceTimelinePort } from '../contract/requires.js'
import type { ScriptFileChange } from '../types/code-surface.js'
import type {
  ScriptVersionRecord,
  TimelineCallRecord,
  TimelineCallView,
  TimelinePoint,
  TimelineRecord,
  TimelineStepRecord,
  WorkspaceScan,
} from '../types/timeline.js'
import { parseMarkerNode } from '../utils/markers.js'
import { callRef, stepRef } from '../utils/refs.js'
import { isClearedCall } from '../utils/timeline.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { TimelineStorageApi } from './TimelineStorage.js'
import { TimelineStorage } from './TimelineStorage.js'
import type { WorkspaceMarkersApi } from './WorkspaceMarkers.js'
import { WorkspaceMarkers } from './WorkspaceMarkers.js'

/** 一个空间的时间线：日志、脚本库、工作区标记。 */
export interface ScriptTimelineApi {
  /** 有没有工作区：没有就不打标记，只记操作。 */
  readonly marking: boolean
  /** 有 exec 在排队或正在做：门丢开着的时间线时跳过它，免得同一个目录冒出第二条、各自分配调用号。 */
  readonly busy: boolean
  /** 读进日志、建好索引；只读一次，之后的查询都在内存里。 */
  load(): Promise<void>
  /** 同一条时间线上的 exec 排队做：一次一个，每一步前后的标记才对得上。 */
  exclusive<T>(task: () => Promise<T>): Promise<T>
  /** 扫一遍工作区；没有工作区、或者文件多到打不了标记时交回 undefined。 */
  scan(signal?: AbortSignal): Promise<Optional<WorkspaceScan>>
  /** 两个标记之间改了哪些文件。 */
  diffMarkers(from: Optional<string>, to: Optional<string>): Promise<ScriptFileChange[]>
  /** 一个标记下的全部文件：相对路径 → 内容哈希。 */
  markerFiles(marker: string): Promise<ReadonlyMap<string, string>>
  /** 最后记下的标记：最近一次记到的工作区的样子。 */
  lastMarker(): Optional<string>
  /** 工作区是这个标记时的那些时间点，按先后排。 */
  pointsAt(marker: string): readonly TimelinePoint[]
  /** 开一次调用：分调用号，把开头那一行写进日志。 */
  begin(input: { session: string; marker?: string; external?: ScriptFileChange[] }): Promise<number>
  /** 记一步：写进日志，更新脚本库与索引。 */
  record(step: TimelineStepRecord): Promise<void>
  /** 全部调用，从旧到新。 */
  calls(): readonly TimelineCallView[]
  /** 一次调用；没有时交回 undefined。 */
  call(call: number): Optional<TimelineCallView>
  /** 一步；没有时交回 undefined。 */
  step(call: number, step: number): Optional<TimelineStepRecord>
  /** 脚本库：路径 → 各版本（从旧到新），按路径排；删掉了的不在里面。 */
  library(): ReadonlyMap<string, readonly ScriptVersionRecord[]>
  /** 删掉了的脚本：路径 → 删之前的最后一版，按路径排。 */
  removedScripts(): ReadonlyMap<string, ScriptVersionRecord>
  /** 一个路径存过的全部版本（从旧到新），删掉了的也算：新版本的号接着它们往下排。 */
  versions(path: string): readonly ScriptVersionRecord[]
  /** 一版脚本：给了版本就是那一版（删掉了的也取得到）；不给就是最新版，删掉了的没有。没有时交回 undefined。 */
  version(path: string, version?: number): Optional<ScriptVersionRecord>
  /** 存一段文字（代码、参数、结果），交回它的哈希。 */
  put(text: string): Promise<string>
  /** 按哈希取回；清掉了时交回 undefined。 */
  get(hash: string): Promise<Optional<string>>
  /**
   * 存的东西超过保留上限时，从最旧的调用清起：清掉结果正文、参数与标记，日志里记下清了什么（清掉参数的步骤不能再重放）。
   * 代码一直留着：脚本库与每一步的代码都在，复盘看得到做过什么。
   */
  prune(): Promise<void>
}

export class ScriptTimeline implements ScriptTimelineApi {
  /** 调用，按调用号从小到大。 */
  private readonly callViews = new Map<number, TimelineCallView>()
  /** 脚本库：路径 → 各版本。 */
  private readonly scripts = new Map<string, ScriptVersionRecord[]>()
  /** 删掉了的脚本路径；之后再存一版就回来了。 */
  private readonly removedPaths = new Set<string>()
  /** 标记 → 工作区是这个样子的那些时间点。 */
  private readonly points = new Map<string, TimelinePoint[]>()
  /** 最近一次记到的标记。 */
  private latestMarker: Optional<string>
  /** 下一次调用的号。 */
  private nextCall = 1
  /** 读日志的那一次。 */
  private loading: Optional<Promise<void>>
  /** exec 排的队。 */
  private queue: Promise<void> = Promise.resolve()
  /** 排着和正在做的 exec 有几个。 */
  private pending = 0

  /** 落盘。 */
  private readonly storage: TimelineStorageApi
  /** 工作区标记；没有工作区时没有。 */
  private readonly markers: Optional<WorkspaceMarkersApi>
  /** 保留上限（字节）。 */
  private readonly retainBytes: number

  /** 按宿主给的位置开：给了 workspace 就给那个目录打标记（时间线目录在工作区里时跳过它），保留上限不给用缺省。用之前先 load。 */
  public constructor(port: CodeSurfaceTimelinePort) {
    this.storage = new TimelineStorage(port.directory)
    this.markers = isUndefined(port.workspace) ? undefined : new WorkspaceMarkers(port.workspace, this.storage, port.directory)
    this.retainBytes = port.retainBytes ?? CodeSurfaceTuning.timelineBytes
  }

  public get marking(): boolean {
    return !isUndefined(this.markers)
  }

  public get busy(): boolean {
    return this.pending > 0
  }

  public load(): Promise<void> {
    this.loading ??= this.storage.readJournal().then((records) => {
      for (const record of records) this.apply(record)
    })
    return this.loading
  }

  public exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1
    const run = this.queue.then(task, task).finally(() => {
      this.pending -= 1
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  public async scan(signal?: AbortSignal): Promise<Optional<WorkspaceScan>> {
    return this.markers?.scan(signal)
  }

  public async diffMarkers(from: Optional<string>, to: Optional<string>): Promise<ScriptFileChange[]> {
    return this.markers ? this.markers.diff(from, to) : []
  }

  public async markerFiles(marker: string): Promise<ReadonlyMap<string, string>> {
    return this.markers ? this.markers.files(marker) : new Map()
  }

  public lastMarker(): Optional<string> {
    return this.latestMarker
  }

  public pointsAt(marker: string): readonly TimelinePoint[] {
    return this.points.get(marker) ?? []
  }

  public async begin(input: { session: string; marker?: string; external?: ScriptFileChange[] }): Promise<number> {
    const record: TimelineCallRecord = { t: 'call', call: this.nextCall, session: input.session, at: Date.now() }
    if (!isUndefined(input.marker)) record.marker = input.marker
    if (input.external && !isEmpty(input.external)) record.external = input.external
    await this.storage.append(record)
    this.apply(record)
    return record.call
  }

  public async record(step: TimelineStepRecord): Promise<void> {
    await this.storage.append(step)
    this.apply(step)
  }

  public calls(): readonly TimelineCallView[] {
    return [...this.callViews.values()]
  }

  public call(call: number): Optional<TimelineCallView> {
    return this.callViews.get(call)
  }

  public step(call: number, step: number): Optional<TimelineStepRecord> {
    return this.callViews.get(call)?.steps.find((record) => record.step === step)
  }

  public library(): ReadonlyMap<string, readonly ScriptVersionRecord[]> {
    return new Map([...this.scripts.entries()].filter(([path]) => !this.removedPaths.has(path)).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
  }

  public removedScripts(): ReadonlyMap<string, ScriptVersionRecord> {
    const removed = new Map<string, ScriptVersionRecord>()
    for (const path of [...this.removedPaths].sort()) {
      const last = this.scripts.get(path)?.at(-1)
      if (last) removed.set(path, last)
    }
    return removed
  }

  public versions(path: string): readonly ScriptVersionRecord[] {
    return this.scripts.get(path) ?? []
  }

  public version(path: string, version?: number): Optional<ScriptVersionRecord> {
    const versions = this.scripts.get(path) ?? []
    if (isUndefined(version)) return this.removedPaths.has(path) ? undefined : versions.at(-1)
    return versions.find((record) => record.version === version)
  }

  public put(text: string): Promise<string> {
    return this.storage.put(text)
  }

  public get(hash: string): Promise<Optional<string>> {
    return this.storage.get(hash)
  }

  public async prune(): Promise<void> {
    if ((await this.storage.size()) <= this.retainBytes) return
    // 一次清一半还没清过的旧调用，再算还剩多少；最近那次调用永远留着。
    let views = this.calls().slice(0, -1).filter((view) => !isClearedCall(view))
    while (!isEmpty(views) && (await this.storage.size()) > this.retainBytes) {
      const batch = views.slice(0, Math.max(1, Math.ceil(views.length / 2)))
      for (const view of batch) this.clear(view)
      await this.storage.rewriteJournal(this.records())
      await this.sweep()
      views = views.slice(batch.length)
    }
  }

  /** 清掉一次调用的结果正文、参数与标记，并记下清了什么；标记跟着从索引里拿掉。 */
  private clear(view: TimelineCallView): void {
    this.forgetPoint(view.record.marker, callRef(view.record.call))
    view.record.marker = undefined
    for (const step of view.steps) {
      const dropped = new Set(step.dropped ?? [])
      if (!isUndefined(step.result)) dropped.add('result')
      if (!isUndefined(step.input) || !isUndefined(step.blobs)) dropped.add('input')
      if (dropped.size > 0) step.dropped = [...dropped]
      this.forgetPoint(step.marker, stepRef(step.call, step.step))
      step.result = undefined
      step.input = undefined
      step.blobs = undefined
      step.marker = undefined
    }
  }

  /** 从「标记 → 时间点」里拿掉一个时间点。 */
  private forgetPoint(marker: Optional<string>, ref: string): void {
    if (isUndefined(marker)) return
    const remaining = (this.points.get(marker) ?? []).filter((point) => point.ref !== ref)
    if (isEmpty(remaining)) this.points.delete(marker)
    else this.points.set(marker, remaining)
  }

  /** 日志里还该有的全部行，按原来的顺序。 */
  private records(): TimelineRecord[] {
    return this.calls().flatMap((view) => [view.record, ...view.steps])
  }

  /** 删掉没人再引用的对象：日志里的代码、参数、结果，以及还留着的标记下的目录节点，都算有人引用。 */
  private async sweep(): Promise<void> {
    const reachable = new Set<string>()
    const markers: string[] = []
    for (const view of this.calls()) {
      if (view.record.marker) markers.push(view.record.marker)
      for (const step of view.steps) {
        for (const hash of [step.code, step.input, step.blobs, step.result]) if (hash) reachable.add(hash)
        if (step.marker) markers.push(step.marker)
      }
    }
    for (const marker of new Set(markers)) await this.collectNodes(marker, reachable)
    const unreachable = [...(await this.storage.inventory()).keys()].filter((hash) => !reachable.has(hash))
    await this.storage.remove(unreachable)
  }

  /** 一个标记下的全部目录节点记进 reachable。 */
  private async collectNodes(node: string, reachable: Set<string>): Promise<void> {
    if (reachable.has(node)) return
    reachable.add(node)
    for (const [, kind, hash] of parseMarkerNode(await this.storage.get(node))) {
      if (kind === 'd') await this.collectNodes(hash, reachable)
    }
  }

  /** 把日志里的一行放进索引。 */
  private apply(record: TimelineRecord): void {
    if (record.t === 'call') {
      this.callViews.set(record.call, { record, steps: [] })
      this.nextCall = Math.max(this.nextCall, record.call + 1)
      if (record.marker) {
        this.notePoint(record.marker, { ref: callRef(record.call), start: true })
        this.latestMarker = record.marker
      }
      return
    }
    const view = this.callViews.get(record.call)
    if (isUndefined(view)) return
    view.steps = [...view.steps.filter((step) => step.step !== record.step), record].sort((left, right) => left.step - right.step)
    if (record.ok && record.path && !isUndefined(record.version) && record.code) {
      const versions = this.scripts.get(record.path) ?? []
      versions.push({ path: record.path, version: record.version, code: record.code, step: stepRef(record.call, record.step), at: record.at })
      this.scripts.set(record.path, versions)
      this.removedPaths.delete(record.path)
    }
    if (record.ok && record.op === 'remove' && record.path) this.removedPaths.add(record.path)
    if (record.marker) {
      this.notePoint(record.marker, { ref: stepRef(record.call, record.step) })
      this.latestMarker = record.marker
    }
  }

  /** 记下工作区在某个时间点是这个标记。 */
  private notePoint(marker: string, point: TimelinePoint): void {
    const known = this.points.get(marker) ?? []
    known.push(point)
    this.points.set(marker, known)
  }
}

