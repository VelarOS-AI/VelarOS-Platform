import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isPlainObject, isString,Log } from '@velaros-ai/core'

import type { ContextPayloadStore } from '../ContextPayloadStore'

import type {
  FileContextCarrier,
  FileContextRange,
  FileContextSnapshot,
  FileContextSource,
  FileContextView,
  FileContextViewTier,
  FileSnapshotRecallInput,
} from './contracts'
import {
  FileObservationToolName,
  FileSnapshotToolName,
  type parseFileSnapshot,
  saveFileRename,
  saveFileSnapshot,
  sliceFileSnapshot,
  tryParseFileRename,
  tryParseFileSnapshot,
} from './FileSnapshotArchive'

function key(workspaceId: string, path: string): string {
  return JSON.stringify([workspaceId, path])
}

/** 显式读取过的文件不会被顺带观察降级；刷新沿用原层级。 */
function resolveViewTier(
  previous: Optional<FileContextView>,
  requested?: FileContextViewTier
): FileContextViewTier {
  if (previous && (previous.tier ?? 'requested') === 'requested') return 'requested'
  return requested ?? previous?.tier ?? 'requested'
}

function tierRank(view: FileContextView): number {
  return view.tier === 'incidental' ? 0 : 1
}

/** 每个执行分支持有自己的活跃范围；刷新只读授权来源，原文仍由宿主持久化。 */
export class FileContextCoordinator {
  public readonly scopeId = globalThis.crypto.randomUUID()
  private readonly sources = new Map<string, FileContextSource>()
  private readonly views = new Map<string, FileContextView>()
  private readonly restoredCalls = new Set<string>()
  private sequence = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: ContextPayloadStore,
    private readonly sessionId: string
  ) {}

  public registerSource(source: FileContextSource): void {
    this.sources.set(source.workspaceId, source)
  }
  public inheritSources(parent: FileContextCoordinator, canRead: () => boolean): void {
    for (const source of parent.sources.values())
      this.registerSource({
        ...source,
        read: (path, ranges, scopeId) => {
          if (!canRead())
            return Promise.reject(new Error('File reading is outside this agent scope'))
          return source.read(path, ranges, scopeId)
        },
        validateArchive: async (snapshot) => {
          if (!canRead()) throw new Error('File recall is outside this agent scope')
          await source.validateArchive?.(snapshot)
        },
      })
  }
  public beginObservation(): number {
    return ++this.sequence
  }

  public archive(snapshots: readonly FileContextSnapshot[], toolCallId?: string): Promise<void> {
    return this.enqueue(async () => {
      for (const snapshot of snapshots) {
        if (!this.sources.has(snapshot.workspaceId)) continue
        await saveFileSnapshot(this.store, this.sessionId, {
          ...snapshot,
          kind: 'file-snapshot',
          version: 1,
          sourceToolCallId: toolCallId,
        })
      }
    })
  }

  public observe(
    snapshots: readonly FileContextSnapshot[],
    sequence: number,
    toolCallId?: string,
    refresh = false,
    tier: FileContextViewTier = 'requested'
  ): Promise<void> {
    return this.enqueue(async () => {
      const groups = new Map<string, FileContextSnapshot[]>()
      for (const snapshot of snapshots) {
        if (!this.sources.has(snapshot.workspaceId)) continue
        const id = key(snapshot.workspaceId, snapshot.path)
        const group = groups.get(id) ?? []
        group.push(snapshot)
        groups.set(id, group)
      }
      for (const [id, group] of groups) {
        const first = group[0]!
        const refs: string[] = []
        let archiveError: string | undefined
        try {
          for (const snapshot of group)
            refs.push(
              await saveFileSnapshot(this.store, this.sessionId, {
                ...snapshot,
                kind: 'file-snapshot',
                version: 1,
                sourceToolCallId: toolCallId,
              })
            )
        } catch (error) {
          archiveError = String(error)
          Log.tag('FileContext').warn('源码归档失败，当前读取仍可使用', { error })
        }
        const previous = this.views.get(id)
        // 即使迟到，读取结果仍属于历史；只有当前指针需要防止倒退。
        if (previous && previous.sequence > sequence) continue
        const viewTier = resolveViewTier(previous, refresh ? undefined : tier)
        if (group.some((item) => item.revision !== first.revision)) {
          this.views.set(id, {
            workspaceId: first.workspaceId,
            path: first.path,
            sequence,
            priority: previous?.priority ?? sequence,
            tier: viewTier,
            status: 'dirty',
            snapshots: [],
            refs: [],
            ranges: [],
            error: 'File changed during snapshot capture',
          })
          continue
        }
        const merge =
          previous?.status === 'fresh' &&
          previous.snapshots[0]?.revision === first.revision &&
          !group.some((item) => item.complete)
        const merged = merge ? [...previous.snapshots, ...group] : group
        const complete = merged.find((item) => item.complete)
        const unique = complete
          ? [complete]
          : [...new Map(merged.map((item) => [JSON.stringify(item.range), item])).values()]
        this.views.set(id, {
          workspaceId: first.workspaceId,
          path: first.path,
          sequence,
          priority: refresh ? (previous?.priority ?? sequence) : sequence,
          tier: viewTier,
          status: first.exists ? 'fresh' : 'deleted',
          snapshots: unique,
          ranges: unique.map((item) => item.range),
          refs: unique.map((snapshot) => {
            const index = group.indexOf(snapshot)
            return index >= 0 ? refs[index] : previous?.refs[previous.snapshots.indexOf(snapshot)]
          }),
          error: archiveError,
        })
      }
      // 限制活跃 IO；档案独立保留，退出工作集的源码只能作为历史证据。
      this.trimViews()
    })
  }

  public touch(
    workspaceId: string,
    paths: readonly string[],
    ranges: Readonly<Record<string, FileContextRange[]>> = {}
  ): void {
    const source = this.sources.get(workspaceId)
    if (!source) return
    for (const raw of paths) {
      const path = source.normalizePath(raw)
      const id = key(workspaceId, path)
      const previous = this.views.get(id)
      this.views.set(id, {
        workspaceId,
        path,
        sequence: ++this.sequence,
        priority: this.sequence,
        tier: 'requested',
        status: 'dirty',
        // 行号未证实能迁移时，只采用本次最终 diff 的范围；否则重新从文件首部确认。
        ranges: ranges[path] ?? [],
        snapshots: [],
        refs: previous?.refs ?? [],
      })
    }
    this.trimViews()
  }

  /** 先淘汰搜索顺带观察的文件，再按最早使用淘汰；显式读取过的文件在工作集里留得更久。 */
  private trimViews(): void {
    if (this.views.size <= 100) return
    const oldest = [...this.views.entries()].sort(
      (a, b) => tierRank(a[1]) - tierRank(b[1]) || a[1].priority - b[1].priority
    )
    for (const [id] of oldest.slice(0, this.views.size - 100)) this.views.delete(id)
  }

  /** 显式读取或修改过的文件排在搜索窗口之前，活动尾预算不足时先省略顺带观察。 */
  public currentViews(): FileContextView[] {
    return structuredClone(
      [...this.views.values()].sort(
        (a, b) => tierRank(b) - tierRank(a) || b.priority - a.priority || a.path.localeCompare(b.path)
      )
    )
  }

  /** Runs after the provider compiler's final clipping; no source grants are issued for omitted text. */
  public async finalizeModelResult(value: unknown): Promise<unknown> {
    const mapExcerpts = (item: unknown, decode: boolean): unknown => {
      if (isArray(item)) return item.map((entry) => mapExcerpts(entry, decode))
      if (!item || !isPlainObject(item) ) return item
      const record = item
      const mapped = Object.fromEntries(Object.entries(record).map(([name, entry]) => [name, mapExcerpts(entry, decode)]))
      if (!decode && mapped.kind === 'project-source-window') {
        delete mapped.viewSource
        if (mapped.continuation && isPlainObject(mapped.continuation)) {
          delete mapped.continuation
          mapped.continuationUnavailable = 'Read the current path again; this window has no usable continuation reference.'
        }
      }
      if (!record.__contextRef) return mapped
      if (decode && isString(record.excerpt) && record.excerpt.includes('project-source-window')) {
        try { mapped.excerpt = mapExcerpts(JSON.parse(record.excerpt), true) }
        catch { Log.tag('FileContext').debug('片段不是完整 JSON，仅保留原始文本证据') }
      } else if (!decode && mapped.excerpt && isPlainObject(mapped.excerpt)) mapped.excerpt = JSON.stringify(mapped.excerpt)
      return mapped
    }
    let result = mapExcerpts(value, true)
    for (const source of this.sources.values())
      if (source.finalizeModelResult) result = await source.finalizeModelResult(result, this.scopeId)
    return mapExcerpts(result, false)
  }

  public async finalizeMessages(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const values: unknown[] = []
    const replacements: Array<(value: unknown) => void> = []
    const finalized = structuredClone(messages)
    for (const message of finalized) {
      if (message.role === 'tool' && isArray(message.content)) {
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue
          if (part.output.type === 'json' || part.output.type === 'error-json') {
            const type = part.output.type
            values.push(part.output.value)
            replacements.push((value) => { part.output = { type, value: JSON.parse(JSON.stringify(value)) } })
          } else if (part.output.type === 'text' || part.output.type === 'error-text') {
            const type = part.output.type
            try {
              values.push(JSON.parse(part.output.value))
              replacements.push((value) => { part.output = { type, value: JSON.stringify(value) } })
            } catch { Log.tag('FileContext').debug('工具文本不是 JSON，不授予结构化源码范围') }
          }
        }
      } else if (message.role === 'user' && isString(message.content) && message.content.startsWith('[Current project files]\n')) {
        const boundary = message.content.indexOf('\n{')
        if (boundary < 0) continue
        try {
          values.push(JSON.parse(message.content.slice(boundary + 1)))
          const prefix = message.content.slice(0, boundary + 1)
          replacements.push((value) => { message.content = prefix + JSON.stringify(value) })
        } catch { Log.tag('FileContext').debug('当前源码尾部不完整，不授予结构化源码范围') }
      }
    }
    // 在同一作用域统一处理，让同版本的不连续可见窗口共用引用。
    const results = await this.finalizeModelResult(values) as unknown[]
    replacements.forEach((replace, index) => replace(results[index]))
    return finalized
  }

  /** 每次发送重新确认活跃源码，因此 watcher 丢事件、外部保留 mtime 的修改也不会靠旧缓存蒙混。 */
  public async prepare(toolCallId?: string): Promise<void> {
    await this.pending
    const targets = this.currentViews()
    for (const target of targets) {
      const source = this.sources.get(target.workspaceId)
      if (!source) continue
      const sequence = this.beginObservation()
      try {
        const snapshots = await source.read(target.path, target.ranges, this.scopeId)
        await this.observe(snapshots, sequence, toolCallId, true)
      } catch (error) {
        const id = key(target.workspaceId, target.path)
        const latest = this.views.get(id)
        if (latest && latest.sequence <= sequence)
          this.views.set(id, {
            ...latest,
            sequence,
            status: 'unavailable',
            snapshots: [],
            error: String(error),
          })
      }
    }
  }

  /** 恢复本分支历史里实际出现的读取路径；不把同会话其他分支的全部文件加载进来。 */
  public async seedHistory(history: readonly ModelMessage[]): Promise<void> {
    const callIds = new Set(
      history.flatMap((message) =>
        message.role === 'tool' && isArray(message.content)
          ? message.content.flatMap((part) =>
              part.type === 'tool-result' &&
              part.toolName.startsWith('project:') &&
              !this.restoredCalls.has(part.toolCallId)
                ? [part.toolCallId]
                : []
            )
          : []
      )
    )
    if (callIds.size) {
      const records = await this.store.listForSession(this.sessionId)
      const observedRefs = new Set<string>()
      for (const record of records) {
        if (record.toolName !== FileObservationToolName || !callIds.has(record.toolCallId)) continue
        try {
          const value = JSON.parse(record.serializedResult) as { kind?: string; ref?: string }
          if (value?.kind === 'file-observation' && isString(value.ref))
            observedRefs.add(value.ref)
        } catch {
          Log.tag('FileContext').debug('跳过损坏的来源记录，继续重新确认其他文件')
        }
      }
      for (const record of records) {
        if (record.toolName !== FileSnapshotToolName) continue
        const snapshot = tryParseFileSnapshot(record.serializedResult)
        if (!snapshot || !this.sources.has(snapshot.workspaceId)) continue
        if (
          !observedRefs.has(record.payloadRef) &&
          (!snapshot.sourceToolCallId || !callIds.has(snapshot.sourceToolCallId))
        )
          continue
        if (!this.views.has(key(snapshot.workspaceId, snapshot.path)))
          this.touch(snapshot.workspaceId, [snapshot.path], { [snapshot.path]: [snapshot.range] })
      }
      for (const id of callIds) this.restoredCalls.add(id)
    }
    for (const message of history) {
      if (message.role !== 'tool' || !isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type !== 'tool-result' || part.toolName !== 'project:read') continue
        const output = part.output
        let value: unknown = output.type === 'json' ? output.value : undefined
        if (output.type === 'text') {
          try {
            value = JSON.parse(output.value)
          } catch {
            Log.tag('FileContext').debug('跳过不完整的历史读取文本')
            continue
          }
        }
        if (!value || !isPlainObject(value) ) continue
        const result = value as {
          rootPath?: string
          files?: Array<{
            snapshot: { path: string; revision?: string }
            range?: FileContextRange
            content?: string
            contentFormat?: string
            totalLines?: number
            truncated?: boolean
            hasMore?: boolean
          }>
        }
        if (!result.rootPath || !isArray(result.files) || !this.sources.has(result.rootPath))
          continue
        for (const file of result.files) {
          if (!file.snapshot || !isString(file.snapshot.path)) continue
          if (
            callIds.has(part.toolCallId) &&
            file.snapshot.revision &&
            isString(file.content)
          ) {
            const range = file.range ?? {
              startLine: 1,
              endLine: Math.max(1, file.totalLines ?? file.content.split('\n').length),
            }
            await saveFileSnapshot(this.store, this.sessionId, {
              kind: 'file-snapshot',
              version: 1,
              workspaceId: result.rootPath,
              path: file.snapshot.path,
              revision: file.snapshot.revision,
              exists: true,
              content:
                file.contentFormat === 'line-numbered'
                  ? file.content
                      .split('\n')
                      .map((line) => line.replace(/^\d+\|/u, ''))
                      .join('\n')
                  : file.content,
              range,
              totalLines: file.totalLines ?? range.endLine,
              complete:
                range.startLine === 1 &&
                (range.startColumn ?? 1) === 1 &&
                !file.truncated &&
                !file.hasMore &&
                range.endLine >= (file.totalLines ?? range.endLine),
              sourceToolCallId: part.toolCallId,
            }).catch((error) => { Log.tag('FileContext').warn('历史源码重新归档失败', { error }) })
          }
          if (!this.views.has(key(result.rootPath, file.snapshot.path)))
            this.touch(
              result.rootPath,
              [file.snapshot.path],
              file.range ? { [file.snapshot.path]: [file.range] } : {}
            )
        }
      }
    }
  }

  public async recordRename(
    workspaceId: string,
    from: string,
    to: string,
    beforeRevision: string,
    afterRevision: string
  ): Promise<void> {
    await this.pending
    await saveFileRename(this.store, this.sessionId, {
      workspaceId,
      from,
      to,
      beforeRevision,
      afterRevision,
    })
  }

  public async recall(input: FileSnapshotRecallInput): Promise<unknown> {
    await this.pending
    const records = await this.store.listForSession(this.sessionId)
    const aliasRefs = new Set<string>()
    if (input.path)
      for (const record of records) {
        if (record.toolName !== '__file_rename__') continue
        const rename = tryParseFileRename(record.serializedResult)
        if (!rename) continue
        const source = this.sources.get(rename.workspaceId)
        if (source && source.normalizePath(input.path) === rename.to)
          for (const ref of rename.refs) aliasRefs.add(ref)
      }
    let accessDenied = false
    let corruptSnapshots = 0
    const matches: Array<{
      ref: string
      createdAt: number
      snapshot: ReturnType<typeof parseFileSnapshot>
    }> = []
    for (const record of records) {
      if (record.toolName !== FileSnapshotToolName) continue
      if (input.ref && record.payloadRef !== input.ref) continue
      const snapshot = tryParseFileSnapshot(record.serializedResult)
      if (!snapshot) {
        corruptSnapshots += 1
        continue
      }
      const source = this.sources.get(snapshot.workspaceId)
      if (!source) continue
      if (
        input.path &&
        source.normalizePath(input.path) !== snapshot.path &&
        !aliasRefs.has(record.payloadRef)
      )
        continue
      if (input.revision && snapshot.revision !== input.revision) continue
      try {
        await source.validateArchive?.(snapshot)
      } catch {
        Log.tag('FileContext').debug('当前权限不允许读取该历史快照')
        accessDenied = true
        continue
      }
      matches.push({ ref: record.payloadRef, createdAt: record.createdAt, snapshot })
    }
    const unique = new Map<string, (typeof matches)[number]>()
    for (const match of matches) {
      const { snapshot } = match
      const id = JSON.stringify([
        snapshot.workspaceId,
        snapshot.path,
        snapshot.revision,
        snapshot.range,
        snapshot.content,
      ])
      if (!unique.has(id) || snapshot.sourceToolCallId) unique.set(id, match)
    }
    matches.splice(0, matches.length, ...unique.values())
    matches.sort((a, b) => b.createdAt - a.createdAt || a.ref.localeCompare(b.ref))
    if (!input.ref && !input.revision) {
      const offset = input.offset ?? 0
      const versions = new Map<string, typeof matches>()
      for (const match of matches) {
        const id = JSON.stringify([match.snapshot.workspaceId, match.snapshot.revision])
        const group = versions.get(id) ?? []
        group.push(match)
        versions.set(id, group)
      }
      const groups = [...versions.values()]
      const page = groups.slice(offset, offset + (input.maxResults ?? 8))
      return {
        kind: 'file-versions',
        historical: true,
        path: input.path,
        offsetUnit: 'version',
        corruptSnapshots,
        restricted: accessDenied,
        versions: page.map((group) => {
          const preferred = group.find((item) => item.snapshot.complete) ?? group[0]!
          return {
            revision: preferred.snapshot.revision,
            complete: preferred.snapshot.complete,
            ref: preferred.ref,
            path: preferred.snapshot.path,
            isCurrent:
              this.views.get(key(preferred.snapshot.workspaceId, preferred.snapshot.path))
                ?.snapshots[0]?.revision === preferred.snapshot.revision,
            snapshots: group.slice(0, 8).map(({ ref, snapshot }) => ({
              ref,
              range: snapshot.range,
              complete: snapshot.complete,
            })),
            omittedSnapshots: Math.max(0, group.length - 8),
          }
        }),
        nextOffset: offset + page.length < groups.length ? offset + page.length : null,
      }
    }
    if (isEmpty(matches))
      return {
        kind: 'file-snapshot',
        historical: true,
        found: false,
        reason: accessDenied
          ? 'Snapshot is restricted by current project policy'
          : corruptSnapshots && input.ref
            ? 'Snapshot archive is corrupt'
            : 'Snapshot not saved or no longer available in this scope',
      }
    const complete = matches.find((match) => match.snapshot.complete)
    if (input.revision && complete) matches.splice(0, matches.length, complete)
    // 一个版本可能只有多个独立片段；先返回引用目录，不能把片段伪装成完整文件。
    if (!input.ref && matches.length > 1)
      return {
        kind: 'file-snapshot',
        historical: true,
        found: true,
        offsetUnit: 'snapshot',
        snapshots: matches
          .slice(input.offset ?? 0, (input.offset ?? 0) + (input.maxResults ?? 8))
          .map(({ ref, snapshot }) => ({
            ref,
            revision: snapshot.revision,
            range: snapshot.range,
            complete: snapshot.complete,
          })),
        nextOffset:
          (input.offset ?? 0) + (input.maxResults ?? 8) < matches.length
            ? (input.offset ?? 0) + (input.maxResults ?? 8)
            : null,
      }
    const { ref, snapshot } = matches[0]!
    return {
      kind: 'file-snapshot',
      historical: true,
      found: true,
      ref,
      path: snapshot.path,
      revision: snapshot.revision,
      range: snapshot.range,
      complete: snapshot.complete,
      redacted: snapshot.redacted,
      ...sliceFileSnapshot(snapshot.content, input.offset ?? 0, input.maxChars ?? 8000),
    }
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action)
    this.pending = result.catch((error) => { Log.tag('FileContext').debug('协调队列操作失败，保留后续任务可执行性', { error }) })
    return result
  }
}

const coordinators = new WeakMap<
  object,
  { sessionId: string; store: ContextPayloadStore; coordinator: FileContextCoordinator }
>()

/** 按执行 tracker 隔离；上下文浅拷贝不会丢服务，tracker 回收后也不会残留全局会话。 */
export function fileContextFor(context: FileContextCarrier): FileContextCoordinator | undefined {
  const owner = context.fileContextScope ?? context.codingSession
  if (!owner || !isPlainObject(owner)  || !context.sessionId || !context.contextPayloadStore)
    return undefined
  const existing = coordinators.get(owner)
  if (
    existing &&
    existing.sessionId === context.sessionId &&
    existing.store === context.contextPayloadStore
  )
    return existing.coordinator
  const coordinator = new FileContextCoordinator(context.contextPayloadStore, context.sessionId)
  coordinators.set(owner, {
    sessionId: context.sessionId,
    store: context.contextPayloadStore,
    coordinator,
  })
  return coordinator
}

/** 子分支继承来源访问口，不继承父分支的活跃源码与预算。 */
export function forkFileContext(parent: FileContextCarrier, child: FileContextCarrier): void {
  const previous = fileContextFor(parent)
  child.fileContextScope = {}
  if (!previous) return
  fileContextFor(child)?.inheritSources(
    previous,
    () =>
      !child.getCurrentVisibleToolNames ||
      child
        .getCurrentVisibleToolNames()
        .some((name) => ['project:read', 'project:search', 'project:code', 'project:write', 'project:edit', 'project:file', 'project:change'].includes(name))
  )
}
