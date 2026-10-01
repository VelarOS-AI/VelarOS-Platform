import type {
  ContextRecord,
  ContextRef,
  ContextRuntime,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isNull, isUndefined } from '@velaros-ai/core'
import { isArray, isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelContinuation, ModelHistoryMessage } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { scriptOutputs } from '@velaros-ai/script'

import { ContextPatchLimits } from '../../system/contract/constants.js'
import type {
  HistoryCheckpoint,
  HistoryListRequest,
  HistoryPage,
  VolumeNarrative,
} from '../../system/types/history.js'
import type {
  ContextHistoryIndex,
  ContextSegment,
  ContextVolume,
  SegmentEntry,
  SegmentHistory,
  SegmentLeasedResult,
  SegmentLedgers,
  VolumeNarrativeRecord,
  VolumeView,
} from '../types/segment.js'
import { memoryFeedbackHistory, memoryOutput } from '../utils/context-memory.js'
import { programFailure } from '../utils/program-context.js'
import {
  archivedJson,
  boundedSkeleton,
  extendLedger,
  frozenRepresentation,
  historyReference,
  responseProse,
  skeletonLine,
} from '../utils/segment.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

/** 段内历史、封卷与卷目录；只投影已落盘的响应和回执，不重放脚本。 */
export interface RecentContextApi {
  /** 在当前授权代次内按序号分页，返回可召回的原文引用。 */
  list(input: HistoryListRequest, signal: AbortSignal): Promise<HistoryPage>
  /** 当前授权代次的段；还没有段时返回 null。 */
  segment(signal: AbortSignal): Promise<Nullable<ContextSegment>>
  /** 目录里的卷（已被合并的不再单列）及各自最新的叙事，按区间排序。 */
  volumes(signal: AbortSignal): Promise<readonly VolumeView[]>
  /** 当前授权代次的全部卷叙事，含已并进上一级的卷，按写入顺序。 */
  narratives(signal: AbortSignal): Promise<readonly VolumeNarrativeRecord[]>
  /** 读取已增量归并的有界长期单，不扫描全部叙事。 */
  ledgers(signal: AbortSignal): Promise<SegmentLedgers>
  /** 段内历史：已冻结的逐字复用到封段，新记录按 entryChars 渲染一次，未冻结且租约失效的结果给引用卡。 */
  project(
    segment: ContextSegment,
    results: readonly SegmentLeasedResult[],
    entryChars: number,
    signal: AbortSignal
  ): Promise<SegmentHistory>
  /** 把 (from, through] 封成一卷，同级卷过多时合并最老的一批；返回新卷引用。 */
  seal(from: number, through: number, signal: AbortSignal): Promise<ContextRef>
  /** 给一卷记下叙事；卷本身不变。 */
  narrate(volume: ContextRef, narrative: VolumeNarrative, signal: AbortSignal): Promise<ContextRef>
  /** 写入新的段状态。 */
  commit(segment: ContextSegment, signal: AbortSignal): Promise<void>
  /** 封段切点：最近 keep 条记录（至少最近两个响应及其结果）留给新段，返回切点序号；能封的不足一个响应时返回 undefined。 */
  cut(segment: ContextSegment, keep: number, signal: AbortSignal): Promise<Optional<number>>
  /** 本授权代次第一段的起点；改造前留下的历史检查点转成第 1 卷，起点从它之后开始。 */
  migrate(signal: AbortSignal): Promise<number>
}

/** 近期分区只投影已落盘响应和回执，整理不会重放脚本。 */
export class RecentContext implements RecentContextApi {
  private readonly resultModes = new Map<string, boolean>()
  private cacheReset = 0
  private referencesReady = false
  public constructor(
    private readonly id: string,
    private readonly context: ContextRuntime,
    private readonly storage: ContextStorage
  ) {}

  private async snapshot(
    selections: Parameters<NonNullable<ContextStorage['selectSnapshot']>>[1]
  ): Promise<Nullable<ContextState>> {
    await this.migrateReferences()
    if (!this.storage.selectSnapshot) return this.storage.load(this.id)
    const selected = await this.storage.selectSnapshot(this.id, [
      { title: 'search:history-reset', latest: true },
      ...selections,
    ])
    return selected ? { ...selected.metadata, records: selected.records } : null
  }

  /** 旧 Runtime 的嵌套正文由其 owner 一次性登记；通用存储不解析业务 JSON。 */
  private async migrateReferences(): Promise<void> {
    if (this.referencesReady) return
    const metadata = this.storage.loadMetadata
      ? await this.storage.loadMetadata(this.id)
      : this.storage.selectSnapshot
        ? (await this.storage.selectSnapshot(this.id, []))?.metadata
        : undefined
    if (metadata?.objectReferencesVersion === 1) {
      this.referencesReady = true
      return
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      const state = await this.storage.load(this.id)
      if (!state) return
      if (state.objectReferencesVersion === 1) {
        this.referencesReady = true
        return
      }
      const protectedObjects = new Set(state.records.map((record) => record.objectId))
      const append: ContextRecord[] = []
      for (const record of state.records) {
        if (
          record.title !== 'context:segment' &&
          record.title !== 'context:delivered' &&
          !record.title.startsWith('context:frame:')
        )
          continue
        const body = await this.storage.get(this.id, record.objectId)
        if (isNull(body)) throw new AppError('NOT_FOUND', '旧上下文记录缺失，不能确认正文引用完整')
        const value = JSON.parse(body) as {
          base?: { objectId: string }
          entries?: ReadonlyArray<{ objectId: string }>
          segment?: { fresh?: ReadonlyArray<{ objectId: string }> }
        }
        const objects = [
          value.base?.objectId,
          ...(value.entries ?? []).map((item) => item.objectId),
          ...(value.segment?.fresh ?? []).map((item) => item.objectId),
        ]
        for (const objectId of objects) {
          if (!objectId || protectedObjects.has(objectId)) continue
          const text = await this.storage.get(this.id, objectId)
          if (isNull(text)) throw new AppError('NOT_FOUND', '旧段正文缺失，引用迁移尚未完成')
          protectedObjects.add(objectId)
          append.push({
            ref: { sessionId: this.id, id: crypto.randomUUID() },
            sequence: (state.records.at(-1)?.sequence ?? 0) + append.length + 1,
            kind: 'audit',
            title: 'context:segment-body',
            objectId,
            chars: text.length,
            sources: [record.ref],
            createdAt: new Date().toISOString(),
          })
        }
      }
      const { records, ...prior } = state
      const next = { ...prior, version: state.version + 1, objectReferencesVersion: 1 as const }
      const committed = this.storage.compareAndSwapMetadata
        ? await this.storage.compareAndSwapMetadata(this.id, state.version, next, append)
        : await this.storage.compareAndSwap(this.id, state.version, {
            ...next,
            records: [...records, ...append],
          })
      if (committed) {
        this.referencesReady = true
        return
      }
    }
    throw new AppError('CONFLICT', '正文引用迁移持续冲突')
  }

  private reset(state: Nullable<ContextState>): number {
    const reset = Math.max(
      state?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ?? 0,
      state?.task?.startedSequence ?? 0
    )
    if (reset !== this.cacheReset) {
      this.resultModes.clear()
      this.cacheReset = reset
    }
    return reset
  }

  private async observation(objectId: string): Promise<boolean> {
    const known = this.resultModes.get(objectId)
    if (!isUndefined(known)) return known
    const raw = await this.storage.get(this.id, objectId)
    // 正文缺失不缓存，后续恢复仍有机会读取；缓存只记不可变正文的分类。
    if (isNull(raw)) return false
    let observation = false
    if (raw)
      try {
        observation = JSON.parse(raw).mode === 'observe'
      } catch {
        Log.tag('ActRuntime').debug('RecentContext 已进入异常处理或降级分支')
      }
    // 保留最早的已分类历史，容量用尽后新条目直接读取，避免顺序扫描造成逐轮缓存抖动。
    if (this.resultModes.size < ActRuntimeTuning.historyClassificationEntries)
      this.resultModes.set(objectId, observation)
    return observation
  }

  public async list(input: HistoryListRequest, signal: AbortSignal): Promise<HistoryPage> {
    signal.throwIfAborted()
    const { after = 0, limit = 32 } = input
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64 ||
      (!isUndefined(input.through) && (!Number.isSafeInteger(input.through) || input.through < 0))
    )
      throw new AppError('VALIDATION', '历史目录范围无效')
    const boundary = this.reset(await this.snapshot([]))
    const lower = Math.max(after, boundary)
    const state = await this.snapshot([
      { kind: 'assistant', after: lower, through: input.through, first: limit + 1 },
      {
        titlePrefix: 'script:',
        titleSuffix: ':result',
        after: lower,
        through: input.through,
        first: limit + 1,
      },
      { latest: true },
    ])
    signal.throwIfAborted()
    const resetAfter = this.reset(state)
    const through = Math.min(input.through ?? Infinity, state?.records.at(-1)?.sequence ?? 0)
    const records = (state?.records ?? []).filter(
      (record) =>
        record.sequence > Math.max(after, resetAfter) &&
        record.sequence <= through &&
        (record.kind === 'assistant' || /^script:[0-9a-f-]{36}:result$/u.test(record.title))
    )
    const page = records.slice(0, limit)
    return {
      items: page.map((record) => ({
        ref: record.ref,
        sequence: record.sequence,
        kind: record.kind === 'assistant' ? 'assistant' : 'result',
        totalChars: record.chars,
      })),
      resetAfter,
      through,
      nextAfter: records.length > limit ? page.at(-1)!.sequence : null,
    }
  }

  public async segment(signal: AbortSignal): Promise<Nullable<ContextSegment>> {
    signal.throwIfAborted()
    const state = await this.snapshot([{ title: 'context:segment', latest: true }])
    const reset = this.reset(state)
    const record = state?.records.findLast(
      (item) => item.title === 'context:segment' && item.sequence > reset
    )
    if (!record) return null
    return JSON.parse((await this.storage.get(this.id, record.objectId))!) as ContextSegment
  }

  public async volumes(signal: AbortSignal): Promise<readonly VolumeView[]> {
    return (await this.historyIndex(signal)).volumes
  }

  public async ledgers(signal: AbortSignal): Promise<SegmentLedgers> {
    return (await this.historyIndex(signal)).ledgers
  }

  /** 活动卷目录在同一版本下增量发布，旧历史只在首次建立索引时读取。 */
  private async historyIndex(signal: AbortSignal): Promise<ContextHistoryIndex> {
    for (let attempt = 0; attempt < 32; attempt++) {
      signal.throwIfAborted()
      const head = await this.snapshot([{ title: 'context:history-index', latest: true }])
      const reset = this.reset(head)
      const saved = head?.records.findLast(
        (item) => item.title === 'context:history-index' && item.sequence > reset
      )
      const previous: ContextHistoryIndex = saved
        ? JSON.parse((await this.storage.get(this.id, saved.objectId))!)
        : {
            through: reset,
            reset,
            volumes: [],
            ledgers: {
              negativeAttempts: { items: [], omitted: 0, sources: [] },
              unresolved: { items: [], omitted: 0, sources: [] },
              constraints: { items: [], omitted: 0, sources: [] },
            },
          }
      const state = await this.snapshot([
        { title: 'context:volume', after: previous.through },
        { title: 'context:volume-narrative', after: previous.through },
        { latest: true },
      ])
      if (!state) return previous
      if (state.version !== head?.version) continue
      const records = state.records.filter(
        (record) =>
          record.sequence > Math.max(reset, previous.through) &&
          ['context:volume', 'context:volume-narrative'].includes(record.title)
      )
      if (isEmpty(records) && saved) return previous
      const volumes = new Map(previous.volumes.map((item) => [item.ref.id, item]))
      let ledgers = previous.ledgers
      for (const record of records) {
        const body = JSON.parse((await this.storage.get(this.id, record.objectId))!)
        if (record.title === 'context:volume') {
          for (const ref of body.parts ?? []) volumes.delete(ref.id)
          volumes.set(record.ref.id, { ref: record.ref, volume: body as ContextVolume })
        } else {
          const { volume, ...narrative } = body as VolumeNarrative & { volume: ContextRef }
          const entry = volumes.get(volume.id)
          if (entry) volumes.set(volume.id, { ...entry, narrative })
          ledgers = {
            ...ledgers,
            negativeAttempts: extendLedger(ledgers.negativeAttempts, [
              { ref: record.ref, items: narrative.negativeAttempts },
            ]),
            unresolved: extendLedger(ledgers.unresolved, [
              { ref: record.ref, items: narrative.unresolved },
            ]),
          }
        }
      }
      const index: ContextHistoryIndex = {
        reset,
        through: state.records.at(-1)?.sequence ?? reset,
        volumes: [...volumes.values()].sort((a, b) => a.volume.from - b.volume.from),
        ledgers,
      }
      const body = JSON.stringify(index)
      const entry = {
        ref: { sessionId: this.id, id: crypto.randomUUID() },
        kind: 'audit' as const,
        title: 'context:history-index',
        objectId: await this.storage.put(this.id, body),
        chars: body.length,
        sources: index.volumes.map((item) => item.ref),
        createdAt: new Date().toISOString(),
      }
      const { records: _records, ...metadata } = state
      if (this.storage.compareAndSwapMetadata) {
        if (
          await this.storage.compareAndSwapMetadata(
            this.id,
            state.version,
            { ...metadata, version: state.version + 1 },
            [entry]
          )
        )
          return index
      } else {
        const full = await this.storage.load(this.id)
        if (full?.version !== state.version) continue
        if (
          await this.storage.compareAndSwap(this.id, state.version, {
            ...full,
            version: state.version + 1,
            records: [
              ...full.records,
              { ...entry, sequence: (full.records.at(-1)?.sequence ?? 0) + 1 },
            ],
          })
        )
          return index
      }
    }
    throw new AppError('CONFLICT', '活动历史索引持续冲突')
  }

  public async narratives(signal: AbortSignal): Promise<readonly VolumeNarrativeRecord[]> {
    signal.throwIfAborted()
    const state = await this.snapshot([{ title: 'context:volume-narrative' }])
    const reset = this.reset(state)
    const narratives: VolumeNarrativeRecord[] = []
    for (const record of state?.records ?? [])
      if (record.title === 'context:volume-narrative' && record.sequence > reset) {
        const { volume, ...narrative } = JSON.parse(
          (await this.storage.get(this.id, record.objectId))!
        ) as VolumeNarrative & { volume: ContextRef }
        narratives.push({ ref: record.ref, volume, narrative })
      }
    return narratives
  }

  public async project(
    segment: ContextSegment,
    results: readonly SegmentLeasedResult[],
    entryChars: number,
    signal: AbortSignal
  ): Promise<SegmentHistory> {
    signal.throwIfAborted()
    const state = await this.snapshot([
      { kind: 'assistant', after: segment.from },
      { titlePrefix: 'script:', titleSuffix: ':result', after: segment.from },
      ...segment.carried.map((refId) => ({ refId })),
      { kind: 'audit', title: 'model-continuation', after: segment.from },
      ...segment.entries.flatMap((entry) =>
        entry.continuation ? [{ refId: entry.continuation.id }] : []
      ),
    ])
    const reset = this.reset(state)
    const carried = new Set(segment.carried)
    const candidates = (state?.records ?? []).filter(
      (record) =>
        record.sequence > reset &&
        (record.sequence > segment.from || carried.has(record.ref.id)) &&
        (record.kind === 'assistant' || /^script:[0-9a-f-]{36}:result$/u.test(record.title))
    )
    const frozen = new Map(segment.entries.map((entry) => [entry.ref, entry]))
    const leased = new Map(results.map((result) => [result.ref, result]))
    const cap = Math.max(1024, entryChars)
    const messages: ModelHistoryMessage[] = []
    const items: Array<SegmentHistory['items'][number]> = []
    const fresh: SegmentEntry[] = []
    const sourceRefs = [
      ...new Set(
        candidates
          .filter((record) => record.kind === 'assistant')
          .flatMap((record) =>
            record.sources.filter((ref) => ref.sessionId === this.id).map((ref) => ref.id)
          )
      ),
    ]
    const sourceState = !isEmpty(sourceRefs)
      ? await this.snapshot(sourceRefs.map((refId) => ({ refId })))
      : null
    const continuations = new Map(
      [...(state?.records ?? []), ...(sourceState?.records ?? [])]
        .filter(
          (record) =>
            record.kind === 'audit' &&
            record.title === 'model-continuation' &&
            record.sequence > reset
        )
        .map((record) => [record.ref.id, record])
    )
    let response = ''
    for (const record of candidates) {
      signal.throwIfAborted()
      if (record.kind !== 'assistant' && (await this.observation(record.objectId))) continue
      const role = record.kind === 'assistant' ? ('assistant' as const) : ('user' as const)
      const entry = frozen.get(record.ref.id)
      const continuationRecord =
        role === 'assistant'
          ? record.sources
              .filter((ref) => ref.sessionId === this.id)
              .map((ref) => continuations.get(ref.id))
              .find((item) => item && item.sequence < record.sequence)
          : undefined
      let continuation: Optional<ModelContinuation>
      if (continuationRecord && (!entry || entry.continuation?.id === continuationRecord.ref.id)) {
        const raw = await this.storage.get(this.id, continuationRecord.objectId)
        if (isNull(raw)) throw new AppError('NOT_FOUND', '模型延续状态缺失')
        continuation = modelRequestEncoder.continuation(JSON.parse(raw))
      }
      const current = leased.get(record.ref.id)
      // 已冻结的条目逐字复用到封段，租约到期或释放只停止帧尾展示：改写已发送的历史会让
      // 只认完整延续的供应商缓存整段失效。从未冻结的结果只在租约有效时第一次渲染，否则给引用卡。
      const item = { ref: record.ref.id, sequence: record.sequence, role }
      if (role === 'user' && !current && !entry) {
        messages.push({ role, content: historyReference(record) })
        items.push({ ...item, bodyIncluded: false, representation: 'reference' })
        continue
      }
      if (entry) {
        const content = await this.storage.get(this.id, entry.objectId)
        if (isNull(content)) throw new AppError('NOT_FOUND', '段内冻结的历史正文缺失')
        messages.push(
          role === 'assistant' && continuation ? { role, content, continuation } : { role, content }
        )
        const frozenItem: SegmentHistory['items'][number] = {
          ...item,
          bodyIncluded: true,
          representation: entry.continuation ? 'full' : frozenRepresentation(content),
        }
        if (entry.feedback) Object.assign(frozenItem, { feedback: entry.feedback })
        if (entry.outputProofs) Object.assign(frozenItem, { outputProofs: entry.outputProofs })
        if (entry.outputFingerprint)
          Object.assign(frozenItem, { outputFingerprint: entry.outputFingerprint })
        if (entry.outputViews) Object.assign(frozenItem, { outputViews: entry.outputViews })
        if (entry.fullMaterial) Object.assign(frozenItem, { fullMaterial: entry.fullMaterial })
        items.push(frozenItem)
        if (role === 'assistant') response = content
        continue
      }
      // 当次源码只在模型看不到它时附上：延续结果的那条响应已封进卷，edits/sourceRef 产生的源码不在响应里
      const rendered = await this.render(
        record,
        role,
        current,
        cap,
        carried.has(record.ref.id) || !response.includes(current?.source ?? ''),
        Boolean(continuation)
      )
      if (!rendered) {
        messages.push({ role, content: historyReference(record) })
        items.push({ ...item, bodyIncluded: false, representation: 'reference' })
        continue
      }
      // 诊断由宿主独立附加，不受脚本 output 筛选；整条放不下时留给当前帧完整展示。
      const { content, feedback } = memoryFeedbackHistory(
        rendered.content,
        current?.feedback ?? [],
        cap
      )
      const outputProofs =
        role === 'user' && current?.structuredOutput
          ? current.outputProofs?.filter(
              (proof) => (proof.carrierRef ?? proof.ref) === record.ref.id
            )
          : undefined
      const delivered = {
        ...(feedback.length ? { feedback } : {}),
        ...(outputProofs?.length ? { outputProofs } : {}),
        ...(role === 'user' && current?.structuredOutput && current.outputViews?.length
          ? { outputViews: current.outputViews }
          : {}),
        ...(rendered.outputFingerprint ? { outputFingerprint: rendered.outputFingerprint } : {}),
        ...(rendered.fullMaterial ? { fullMaterial: rendered.fullMaterial } : {}),
      }
      const frozenBody = await this.context.append(
        {
          kind: 'audit',
          title: 'context:history-body',
          body: content,
          sources: [record.ref],
        },
        signal
      )
      const objectId = frozenBody.objectId
      const completeContinuation = continuation && rendered.representation === 'full'
      const freshEntry: SegmentEntry = {
        ref: record.ref.id,
        sequence: record.sequence,
        role,
        objectId,
        chars: content.length,
        ...delivered,
      }
      if (completeContinuation) Object.assign(freshEntry, { continuation: continuationRecord!.ref })
      fresh.push(freshEntry)
      messages.push(
        role === 'assistant' && completeContinuation
          ? { role, content, continuation }
          : { role, content }
      )
      items.push({
        ...item,
        bodyIncluded: true,
        representation: rendered.representation,
        ...delivered,
      })
      if (role === 'assistant') response = content
    }
    // 需要显式断点的供应商：在第一个仍有租约的结果之前的 user 结果结尾另留一处断点，
    // 后续帧仍能通过隐式的早期消息边界查到旧缓存点。
    const firstLeased = items.findIndex((item) => item.role === 'user' && leased.has(item.ref))
    const stableBoundary = items
      .slice(0, firstLeased < 0 ? items.length : firstLeased)
      .findLastIndex((item) => item.role === 'user')
    if (stableBoundary >= 0)
      messages[stableBoundary] = { ...messages[stableBoundary], cacheBreakpoint: true }
    // 历史末尾另留断点，覆盖没有租约变更的连续请求。
    if (!isEmpty(messages))
      messages[messages.length - 1] = { ...messages.at(-1)!, cacheBreakpoint: true }
    return { messages, items, fresh }
  }

  /** 第一次交付时的正文；放不下的结构化输出不截半，交给引用卡。 */
  private async render(
    record: ContextRecord,
    role: 'user' | 'assistant',
    current: Optional<SegmentLeasedResult>,
    cap: number,
    withSource: boolean,
    continuation: boolean
  ): Promise<
    Optional<{
      content: string
      representation: 'full' | 'excerpt'
      outputFingerprint?: string
      fullMaterial?: string
    }>
  > {
    if (role === 'assistant') {
      const content = await this.context.read(record.ref, { limit: cap })
      const representation = content.totalChars > content.text.length ? 'excerpt' : 'full'
      if (continuation && representation === 'full')
        return { content: content.text, representation }
      return {
        content: `${JSON.stringify({
          origin: 'assistant-script',
          sequence: record.sequence,
          ref: record.ref,
          representation,
          bodyIncluded: true,
          totalChars: content.totalChars,
        })}\n${content.text}`,
        representation,
      }
    }
    const text = current?.text ?? ''
    if (!text || (current?.structuredOutput && text.length > cap)) return undefined
    const output = text.length > cap ? text.slice(0, cap) : text
    const encoded = current?.structuredOutput ? memoryOutput(output, current.outputFormat) : output
    const representation = output.length === record.chars ? 'full' : 'excerpt'
    return {
      content: [
        JSON.stringify({
          origin: 'runtime-execution',
          sequence: record.sequence,
          ref: record.ref,
          sourceRef: current?.sourceRef,
          representation,
          bodyIncluded: true,
          totalChars: record.chars,
        }),
        ...(withSource && current?.source ? ['当次源码：', current.source] : []),
        '当次输出：',
        encoded,
      ].join('\n'),
      representation,
      outputFingerprint: scriptOutputs.hash([
        this.id,
        record.ref.id,
        current?.sourceRef ?? null,
        encoded,
      ]),
      fullMaterial:
        !current?.structuredOutput && current?.materialCoverage?.complete && output === text
          ? current.materialCoverage.identity
          : undefined,
    }
  }

  public async seal(from: number, through: number, signal: AbortSignal): Promise<ContextRef> {
    signal.throwIfAborted()
    // 只取骨架用得到的记录；任务元数据（写效果回执）随同一读快照返回
    const state = await this.snapshot([
      { kind: 'user', after: from, through },
      { kind: 'assistant', after: from, through },
      { titlePrefix: 'script:', titleSuffix: ':result', after: from, through },
      { titlePrefix: 'workspace:note:', after: from, through },
    ])
    if (!state) throw new AppError('UNAVAILABLE', '近期记录尚未建立')
    // 授权重置之前的记录不属于本代次，骨架也不收
    const start = Math.max(from, this.reset(state))
    if (!Number.isSafeInteger(through) || through <= start)
      throw new AppError('VALIDATION', '封卷区间为空')
    const volume = await this.skeleton(state, start, through, signal)
    const sealed = await this.context.append(
      { kind: 'checkpoint', title: 'context:volume', body: JSON.stringify(volume), sources: [] },
      signal
    )
    await this.merge(signal)
    return sealed.ref
  }

  /** 同级卷超过上限时把最老的一批合并成上一级，逐级进行，目录条数因此有界。 */
  private async merge(signal: AbortSignal): Promise<void> {
    for (let level = 1; level < 16; level++) {
      const views = (await this.volumes(signal)).filter((item) => item.volume.level === level)
      if (views.length <= ActRuntimeTuning.volumeIndex) return
      const parts = views.slice(0, ActRuntimeTuning.volumeMerge)
      const merged: ContextVolume = {
        level: level + 1,
        from: parts[0]!.volume.from,
        through: parts.at(-1)!.volume.through,
        turns: parts.reduce((sum, item) => sum + item.volume.turns, 0),
        results: parts.reduce((sum, item) => sum + item.volume.results, 0),
        failures: parts.reduce((sum, item) => sum + item.volume.failures, 0),
        effects: parts.reduce((sum, item) => sum + item.volume.effects, 0),
        notes: [...new Set(parts.flatMap((item) => item.volume.notes))].slice(
          -ActRuntimeTuning.volumeNotes
        ),
        inputs: parts.reduce((sum, item) => sum + item.volume.inputs, 0),
        skeleton: '',
        parts: parts.map((item) => item.ref),
      }
      await this.context.append(
        {
          kind: 'checkpoint',
          title: 'context:volume',
          body: JSON.stringify(merged),
          sources: [],
        },
        signal
      )
    }
  }

  /** 逐轮一行的规则骨架：模型说明首行、结果状态、写效果、改过的笔记、用户输入；不调用模型。 */
  private async skeleton(
    state: ContextState,
    from: number,
    through: number,
    signal: AbortSignal
  ): Promise<ContextVolume> {
    const records = state.records.filter(
      (record) => record.sequence > from && record.sequence <= through
    )
    const lines: string[] = []
    const notes = new Map<string, string>()
    const executions = new Set<string>()
    let turns = 0
    let results = 0
    let failures = 0
    let inputs = 0
    for (const record of records) {
      signal.throwIfAborted()
      if (record.kind === 'user') {
        inputs++
        const input = await this.context.readInput(record.ref, {
          limit: ActRuntimeTuning.volumeLineChars,
        })
        lines.push(`用户 #${record.sequence}：${skeletonLine(input.text.split('\n')[0] ?? '')}`)
      } else if (record.kind === 'assistant') {
        turns++
        const prose = responseProse((await this.storage.get(this.id, record.objectId)) ?? '')
        lines.push(`模型 #${record.sequence}：${skeletonLine(prose ?? '（只有程序段）')}`)
      } else if (/^script:[0-9a-f-]{36}:result$/u.test(record.title)) {
        const body = archivedJson(await this.storage.get(this.id, record.objectId)) as {
          mode?: unknown
          output?: { blocks?: unknown }
        }
        if (body.mode === 'observe') continue
        results++
        executions.add(record.title.slice(7, -7))
        const failure = programFailure(body)
        if (failure) failures++
        const keys = isArray(body.output?.blocks)
          ? body.output.blocks
              .map((block) => (block as { key?: unknown }).key)
              .filter((key): key is string => isString(key))
          : []
        lines.push(
          `结果 #${record.sequence}：${failure ? `失败 ${failure.code ?? ''} ${skeletonLine(failure.message)}`.trim() : '成功'}${keys.length ? `｜输出 ${keys.slice(0, 8).join(', ')}` : ''}｜${record.chars} 字符`
        )
      } else if (record.title.startsWith('workspace:note:')) {
        const note = archivedJson(await this.storage.get(this.id, record.objectId))
        if (isString(note.key)) notes.set(note.key, `${note.key}@${String(note.revision)}`)
      }
    }
    const effects = (state.task?.mandatory ?? []).filter(
      (item) => executions.has(item.executionId) && item.effect !== 'none'
    )
    for (const effect of effects.slice(0, 16))
      lines.push(`写效果：${effect.operation}｜${effect.effect}｜${effect.outcome}`)
    if (notes.size) lines.push(`笔记：${[...notes.values()].join(', ')}`)
    return {
      level: 1,
      from,
      through,
      turns,
      results,
      failures,
      effects: effects.length,
      notes: [...notes.values()].slice(-ActRuntimeTuning.volumeNotes),
      inputs,
      skeleton: boundedSkeleton(lines),
    }
  }

  public async narrate(
    volume: ContextRef,
    narrative: VolumeNarrative,
    signal: AbortSignal
  ): Promise<ContextRef> {
    signal.throwIfAborted()
    if (
      !isString(narrative.summary) ||
      !narrative.summary.trim() ||
      narrative.summary.length > ContextPatchLimits.summaryChars ||
      !isArray(narrative.unresolved) ||
      !isArray(narrative.negativeAttempts) ||
      !isArray(narrative.evidence) ||
      narrative.unresolved.length > ContextPatchLimits.unresolved ||
      narrative.negativeAttempts.length > ContextPatchLimits.unresolved ||
      [...narrative.unresolved, ...narrative.negativeAttempts].some(
        (item) => !isString(item) || item.length > ContextPatchLimits.unresolvedChars
      ) ||
      narrative.evidence.length > ContextPatchLimits.items
    )
      throw new AppError('VALIDATION', '卷叙事格式或大小无效')
    const state = await this.snapshot([
      { title: 'context:volume' },
      ...narrative.evidence.map((ref) => ({ refId: ref.id })),
    ])
    const reset = this.reset(state)
    const records = (state?.records ?? []).filter((record) => record.sequence > reset)
    if (!records.some((record) => record.title === 'context:volume' && record.ref.id === volume.id))
      throw new AppError('NOT_FOUND', '要写叙事的卷不在当前授权代次')
    for (const ref of narrative.evidence)
      if (ref.sessionId !== this.id || !records.some((record) => record.ref.id === ref.id))
        throw new AppError('PERMISSION', '旧材料需要在当前授权范围内重新获取')
    const record = await this.context.append(
      {
        kind: 'checkpoint',
        title: 'context:volume-narrative',
        body: JSON.stringify({ volume, ...narrative }),
        sources: [volume, ...narrative.evidence],
      },
      signal
    )
    return record.ref
  }

  public async commit(segment: ContextSegment, signal: AbortSignal): Promise<void> {
    await this.context.append(
      { kind: 'audit', title: 'context:segment', body: JSON.stringify(segment), sources: [] },
      signal
    )
  }

  public async cut(
    segment: ContextSegment,
    keep: number,
    signal: AbortSignal
  ): Promise<Optional<number>> {
    signal.throwIfAborted()
    const state = await this.snapshot([
      { kind: 'assistant', after: segment.from },
      { titlePrefix: 'script:', titleSuffix: ':result', after: segment.from },
    ])
    const reset = this.reset(state)
    const records = []
    for (const record of state?.records ?? []) {
      if (
        record.sequence <= Math.max(reset, segment.from) ||
        !(record.kind === 'assistant' || /^script:[0-9a-f-]{36}:result$/u.test(record.title)) ||
        (record.kind !== 'assistant' && (await this.observation(record.objectId)))
      )
        continue
      records.push(record)
    }
    const responses = records.filter((record) => record.kind === 'assistant')
    if (responses.length < 3) return undefined
    const first = Math.min(
      responses.at(-2)!.sequence,
      records.at(-Math.max(1, Math.min(keep, records.length)))!.sequence
    )
    const through = first - 1
    return responses.some((record) => record.sequence <= through) ? through : undefined
  }

  public async migrate(signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const state = await this.snapshot([
      { title: 'search:history-checkpoint', latest: true },
      { title: 'context:volume', latest: true },
    ])
    const reset = this.reset(state)
    const record = state?.records.findLast(
      (item) => item.title === 'search:history-checkpoint' && item.sequence > reset
    )
    if (!record) return reset
    const checkpoint = JSON.parse(
      (await this.storage.get(this.id, record.objectId))!
    ) as HistoryCheckpoint
    // 已经迁移过（本代次已有卷）就不再重复写
    if (!state?.records.some((item) => item.title === 'context:volume' && item.sequence > reset)) {
      const volume: ContextVolume = {
        level: 1,
        from: Math.max(reset, checkpoint.baseThrough),
        through: checkpoint.through,
        turns: 0,
        results: 0,
        failures: 0,
        effects: 0,
        notes: [],
        inputs: 0,
        skeleton: '',
      }
      const sealed = await this.context.append(
        { kind: 'checkpoint', title: 'context:volume', body: JSON.stringify(volume), sources: [] },
        signal
      )
      await this.context.append(
        {
          kind: 'checkpoint',
          title: 'context:volume-narrative',
          body: JSON.stringify({
            volume: sealed.ref,
            summary: checkpoint.summary,
            evidence: checkpoint.evidence,
            unresolved: checkpoint.unresolved,
            negativeAttempts: checkpoint.negativeAttempts,
          }),
          sources: [sealed.ref, record.ref],
        },
        signal
      )
    }
    return Math.max(reset, checkpoint.through)
  }
}
