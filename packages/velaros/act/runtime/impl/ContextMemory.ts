import type {
  ContextContent,
  ContextFeedback,
  ContextRecord,
  ContextRecordSelection,
  ContextRef,
  ContextRuntime,
  ContextStorage,
  ContextViewApi,
  ModelView,
} from '@velaros-ai/context'
import { ContextLimits } from '@velaros-ai/context'
import { isEmpty } from '@velaros-ai/core'
import { isFalse, isNull, isUndefined, toNullable } from '@velaros-ai/core'
import { isArray, isBoolean, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelHistoryMessage, ModelImage } from '@velaros-ai/kernel'
import type { WorkspaceEntry, WorkspaceUpdate } from '@velaros-ai/velaros/act/system'

import { WorkspaceLimits } from '../../system/contract/constants.js'
import type { ContextProjectionPolicy } from '../../system/types/maintenance.js'
import type {
  MemoryContent,
  MemoryPage,
  MemoryQuery,
  MemoryRetention,
} from '../../system/types/memory.js'
import type { ScriptRetention } from '../../system/types/results.js'
import type {
  ContextMemoryPolicy,
  RuntimeNoteContent,
  RuntimeNoteRead,
  WorkspaceNote,
} from '../types/memory.js'
import type { ContextSegment, FoldedGoals, SegmentReason, SegmentStatus } from '../types/segment.js'
import {
  adjustedWorkspaceShare,
  memoryCommittedGroups,
  memoryFeedbackKey,
  memoryPolicy,
  memoryPrompt,
  memoryReference,
  memoryTaskHistory,
  noteEntry,
} from '../utils/context-memory.js'
import { readMaterialField } from '../utils/materials.js'
import { archivedJson, segmentBase, segmentLedgers, skeletonLine } from '../utils/segment.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

import type { ProgramContextApi } from './ProgramContext.js'
import type { RecentContextApi } from './RecentContext.js'

/** 工作区和五分区帧的唯一组装端口。 */
export interface ContextMemoryApi {
  /** 当前任务的原文目录；只读取元数据。 */
  catalog(input: MemoryQuery, signal: AbortSignal): Promise<MemoryPage>
  /** 所有原文共用范围校验与既有读取器。 */
  readMaterial(
    ref: ContextRef | string,
    offset: Optional<number>,
    limit: Optional<number>,
    signal: AbortSignal,
    pointer?: string
  ): Promise<MemoryContent>
  /** 调整笔记或执行结果驻留，原文不可变。 */
  retainMaterial(
    ref: ContextRef | string,
    turns: Nullable<ScriptRetention>,
    signal: AbortSignal
  ): Promise<MemoryRetention>
  /** 按稳定键及版本前提追加不可变笔记版本。 */
  update(input: WorkspaceUpdate, signal: AbortSignal): Promise<WorkspaceEntry>
  /** 当前授权代次内的笔记目录，包含已移出内存的条目。 */
  list(
    input: { after?: string; limit?: number },
    signal: AbortSignal
  ): Promise<{ items: readonly WorkspaceEntry[]; nextAfter: Nullable<string> }>
  /** 宿主读取确定版本的笔记正文页，隐藏内部归档封装。 */
  readNote(input: RuntimeNoteRead, signal: AbortSignal): Promise<RuntimeNoteContent>
  /** 按原始引用召回笔记的归档内容。 */
  read(
    ref: ContextRef,
    offset: Optional<number>,
    limit: Optional<number>,
    signal: AbortSignal
  ): Promise<ContextContent>
  /** 合并段底座、段内历史与本帧五分区，生成同一快照。 */
  project(
    view: ModelView,
    observation: Optional<ContextRef>,
    images: readonly ModelImage[],
    signal: AbortSignal,
    maxChars: number
  ): Promise<{
    body: string
    images: readonly ModelImage[]
    prompt: string
    history: readonly ModelHistoryMessage[]
    segment: SegmentStatus
  }>
  /** 只以实际接收成功的快照更新分区变化基线，并冻结本帧新交付的段内历史。 */
  acknowledge(frameId: string, signal: AbortSignal): Promise<void>
  /** 把段内较早的历史封成一卷并开始新的一段，不调用模型；能封的不足一个响应时返回 false。 */
  fold(reason: SegmentReason, maxChars: number, signal: AbortSignal): Promise<boolean>
  /** 是否处在章节边界：有待处理的整理请求、段内来了新的用户输入，或计划的下一目标变了。 */
  boundary(signal: AbortSignal): Promise<boolean>
  /** 取走自动封段留下的补写叙事标记，只取一次；没有时返回 null。 */
  narration(signal: AbortSignal): Promise<Nullable<ContextRef>>
}

/** 同一可靠存储上的工作内存，分区只改变组装与驻留，不改变事实和权限。 */
export class ContextMemory implements ContextMemoryApi {
  private readonly policy: Required<ContextMemoryPolicy>
  /** 已记过缺页的材料，只针对最近送达的那一帧。 */
  private readonly faulted = new Set<string>()
  private faultFrame = ''

  public constructor(
    private readonly id: string,
    private readonly context: ContextRuntime,
    private readonly storage: ContextStorage,
    private readonly view: ContextViewApi,
    private readonly programs: ProgramContextApi,
    private readonly recent: RecentContextApi,
    policy?: ContextMemoryPolicy
  ) {
    this.policy = memoryPolicy(policy)
  }

  private async snapshot(signal: AbortSignal, selections?: readonly ContextRecordSelection[]) {
    signal.throwIfAborted()
    const selected =
      selections && this.storage.selectSnapshot
        ? await this.storage.selectSnapshot(this.id, selections)
        : undefined
    const snapshot =
      selections && this.storage.selectSnapshot
        ? selected
          ? { ...selected.metadata, records: selected.records }
          : null
        : await this.storage.load(this.id)
    signal.throwIfAborted()
    return snapshot
  }

  private async notes(
    signal: AbortSignal,
    selective = false,
    selections: readonly ContextRecordSelection[] = []
  ) {
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

  public async update(input: WorkspaceUpdate, signal: AbortSignal): Promise<WorkspaceEntry> {
    if (
      !isString(input.key) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(input.key) ||
      input.key.length > WorkspaceLimits.keyChars ||
      !Number.isSafeInteger(input.baseRevision) ||
      input.baseRevision < 0
    )
      throw new AppError('MEMORY_INPUT', '笔记键或版本无效')
    if (
      (!isUndefined(input.body) &&
        (!isString(input.body) || input.body.length > WorkspaceLimits.bodyChars)) ||
      (!isUndefined(input.title) &&
        (!isString(input.title) || input.title.length > WorkspaceLimits.titleChars)) ||
      (!isUndefined(input.resident) && !isBoolean(input.resident)) ||
      (!isUndefined(input.sources) &&
        (!isArray(input.sources) || input.sources.length > WorkspaceLimits.sources))
    )
      throw new AppError('MEMORY_INPUT', '笔记内容超限或类型无效')
    if (['body', 'title', 'sources', 'resident'].every((key) => !Object.hasOwn(input, key)))
      throw new AppError('MEMORY_INPUT', '笔记更新为空')
    for (let attempt = 0; attempt < 32; attempt++) {
      const incremental = Boolean(
        this.storage.selectSnapshot && this.storage.compareAndSwapMetadata
      )
      const { snapshot, notes } = await this.notes(signal, incremental)
      if (!snapshot) throw new AppError('UNAVAILABLE', '会话尚未建立')
      const prior = notes.find((item) => item.note.key === input.key)
      if ((prior?.note.revision ?? 0) !== input.baseRevision)
        throw AppError.withFields('WORKSPACE_CONFLICT', '笔记版本已变化，请按当前 revision 修改', {
          currentRevision: prior?.note.revision ?? 0,
        })
      if (!prior && isUndefined(input.body)) throw new AppError('MEMORY_INPUT', '新笔记需要正文')
      if (!prior && notes.length >= 256)
        throw new AppError('WORKSPACE_LIMIT', '工作区笔记目录已满，请复用已有键')
      const sources = input.sources ?? prior?.note.sources ?? []
      let authorization = snapshot
      if (incremental && !isEmpty(sources)) {
        const selected = await this.storage.selectSnapshot!(this.id, [
          { title: 'search:history-reset', latest: true },
          { kind: 'user' },
          ...sources.map((ref) => ({ refId: ref.id })),
        ])
        if (!selected || selected.metadata.version !== snapshot.version) continue
        authorization = { ...selected.metadata, records: selected.records }
      }
      if (sources.some((ref) => ref.sessionId !== this.id || !memoryReference(authorization, ref)))
        throw new AppError('SCOPE_MISMATCH', '笔记来源不在当前授权范围')
      const task = await this.view.inspect()
      const stamps = sources.flatMap(
        (ref) =>
          task?.view?.evidence.find((item) => item.recovery.id === ref.id)?.readSet ??
          task?.provenance?.find((item) => item.ref.id === ref.id)?.readSet ??
          []
      )
      const note: WorkspaceNote = {
        key: input.key,
        revision: input.baseRevision + 1,
        title: input.title ?? prior?.note.title ?? input.key,
        body: input.body ?? prior!.note.body,
        sources,
        resident: input.resident ?? prior?.note.resident ?? true,
        stamps: isUndefined(input.sources) && prior ? prior.note.stamps : stamps,
        origin: 'model-note',
      }
      const body = JSON.stringify(note)
      const objectId = await this.storage.put(this.id, body)
      const record: ContextRecord = {
        ref: { sessionId: this.id, id: crypto.randomUUID() },
        sequence: (snapshot.records.at(-1)?.sequence ?? 0) + 1,
        kind: 'note',
        title: `workspace:note:${input.key}`,
        objectId,
        chars: body.length,
        sources,
        createdAt: new Date().toISOString(),
      }
      signal.throwIfAborted()
      if (incremental) {
        const { records: _records, ...metadata } = snapshot
        if (
          await this.storage.compareAndSwapMetadata!(
            this.id,
            snapshot.version,
            { ...metadata, version: snapshot.version + 1 },
            [record]
          )
        )
          return noteEntry(note, record)
      } else if (
        await this.storage.compareAndSwap(this.id, snapshot.version, {
          ...snapshot,
          version: snapshot.version + 1,
          records: [...snapshot.records, record],
        })
      )
        return noteEntry(note, record)
    }
    throw new AppError('WORKSPACE_BUSY', '工作区持续发生并发变化')
  }

  public async list(input: { after?: string; limit?: number }, signal: AbortSignal) {
    const limit = input.limit ?? ActRuntimeTuning.workspacePage
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WorkspaceLimits.maxPage)
      throw new AppError('VALIDATION', `笔记目录每页 1–${WorkspaceLimits.maxPage} 条`)
    const { notes } = await this.notes(signal, true)
    const items = notes
      .map((item) => noteEntry(item.note, item.record))
      .filter((item) => isUndefined(input.after) || item.key > input.after)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const page = items.slice(0, limit)
    return { items: page, nextAfter: items.length > limit ? page.at(-1)!.key : null }
  }

  public async readNote(input: RuntimeNoteRead, signal: AbortSignal): Promise<RuntimeNoteContent> {
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
    const { notes } = await this.notes(signal, true)
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

  public async read(
    ref: ContextRef,
    offset: Optional<number>,
    limit: Optional<number>,
    signal: AbortSignal
  ): Promise<ContextContent> {
    const snapshot = await this.snapshot(signal, [
      { title: 'search:history-reset', latest: true },
      { refId: ref.id },
    ])
    const reset = Math.max(
      snapshot?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ??
        0,
      snapshot?.task?.startedSequence ?? 0
    )
    if (
      ref.sessionId !== this.id ||
      !snapshot?.records.some(
        (record) =>
          record.ref.id === ref.id &&
          record.sequence > reset &&
          record.title.startsWith('workspace:note:')
      )
    )
      throw new AppError('SCOPE_MISMATCH', '笔记引用不在当前授权范围')
    return this.context.read(ref, { offset, limit })
  }

  public async catalog(input: MemoryQuery, signal: AbortSignal): Promise<MemoryPage> {
    const limit = input.limit ?? ActRuntimeTuning.workspacePage
    const after = input.after ?? 0
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > WorkspaceLimits.maxPage ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      (!isUndefined(input.through) && (!Number.isSafeInteger(input.through) || input.through < 0))
    )
      throw new AppError('VALIDATION', '材料目录分页无效')
    const { snapshot, reset, notes } = await this.notes(signal)
    const latest = new Map(notes.map((item) => [item.record.ref.id, item]))
    const reattached = new Set(
      (snapshot?.records ?? [])
        .filter((record) => record.sequence > reset && record.kind === 'user')
        .flatMap((record) => record.sources.map((ref) => JSON.stringify([ref.sessionId, ref.id])))
    )
    const items = []
    for (const record of snapshot?.records ?? []) {
      if (
        record.sequence <= after ||
        record.sequence > (input.through ?? Infinity) ||
        (record.sequence <= reset &&
          !reattached.has(JSON.stringify([record.ref.sessionId, record.ref.id])))
      )
        continue
      const kind = record.title.startsWith('workspace:note:')
        ? 'notes'
        : record.kind === 'user' || record.sequence <= reset
          ? 'inputs'
          : record.title === `script:${record.ref.id}` || record.title === 'shared:script'
            ? 'programs'
            : /^script:.*:result$/u.test(record.title)
              ? 'results'
              : record.kind === 'note' || record.title === 'model-tool:delivery'
                ? 'artifacts'
                : record.kind === 'assistant'
                  ? 'history'
                  : null
      if (
        !kind ||
        (input.kind &&
          input.kind !== 'all' &&
          kind !== input.kind &&
          !(input.kind === 'history' && kind === 'results')) ||
        (kind === 'notes' && !latest.has(record.ref.id)) ||
        (input.query &&
          !`${record.title} ${latest.get(record.ref.id)?.note.title ?? ''}`
            .toLowerCase()
            .includes(input.query.toLowerCase()))
      )
        continue
      const note = latest.get(record.ref.id)
      items.push({ ...record, ...(note ? noteEntry(note.note, record) : {}) })
      if (items.length > limit) break
    }
    const page = items.slice(0, limit)
    return { items: page, nextAfter: items.length > limit ? page.at(-1)!.sequence : null }
  }

  public async readMaterial(
    value: ContextRef | string,
    offset: Optional<number>,
    limit: Optional<number>,
    signal: AbortSignal,
    pointer?: string
  ): Promise<MemoryContent> {
    const ref = isString(value) ? { sessionId: this.id, id: value } : value
    const snapshot = await this.snapshot(signal, [
      { title: 'search:history-reset', latest: true },
      { kind: 'user' },
      { refId: ref.id },
    ])
    const record = memoryReference(snapshot, ref)
    if (ref.sessionId !== this.id || !record)
      throw new AppError('SCOPE_MISMATCH', '材料引用不在当前任务授权范围')
    await this.fault(ref, signal)
    if (!isUndefined(pointer)) {
      if (!/^script:[^:]+:result$/u.test(record.title ?? ''))
        throw new AppError('VALIDATION', '字段召回仅适用于执行结果归档')
      const archived = await this.storage.get(this.id, record.objectId)
      signal.throwIfAborted()
      if (isNull(archived)) throw new AppError('NOT_FOUND', '执行结果原文不可用')
      return { record, ...readMaterialField(archived, pointer, offset, limit) }
    }
    if (record.kind === 'user') return this.context.readInput(ref, { offset, limit })
    if (record.title === 'task:artifact') return this.view.readArtifact(ref, { offset, limit })
    return this.context.read(ref, { offset, limit })
  }

  /** 读回的材料在最近送达的一帧里因容量不够只给了引用：按分区记一次缺页，同一帧同一份只记一次。 */
  private async fault(ref: ContextRef, signal: AbortSignal): Promise<void> {
    const snapshot = await this.snapshot(signal, [{ title: 'context:delivered', latest: true }])
    const record = snapshot?.records.findLast((item) => item.title === 'context:delivered')
    if (!record) return
    const frame = JSON.parse((await this.storage.get(this.id, record.objectId))!) as {
      frameId: string
      segment?: { id: string }
      squeezed?: ReadonlyArray<{ ref: string; partition: 'workspace' | 'results' }>
    }
    if (frame.frameId !== this.faultFrame) {
      this.faultFrame = frame.frameId
      this.faulted.clear()
    }
    const squeezed = frame.squeezed?.find((item) => item.ref === ref.id)
    if (!squeezed || !frame.segment || this.faulted.has(ref.id)) return
    this.faulted.add(ref.id)
    await this.context.append(
      {
        kind: 'audit',
        title: `context:fault:${frame.segment.id}:${squeezed.partition}`,
        body: JSON.stringify({ ref, partition: squeezed.partition, frameId: frame.frameId }),
        sources: [ref],
      },
      signal
    )
  }

  public async retainMaterial(
    value: ContextRef | string,
    turns: Nullable<ScriptRetention>,
    signal: AbortSignal
  ): Promise<MemoryRetention> {
    const ref = isString(value) ? { sessionId: this.id, id: value } : value
    const snapshot = await this.snapshot(signal, [
      { title: 'search:history-reset', latest: true },
      { kind: 'user' },
      { refId: ref.id },
    ])
    const record = memoryReference(snapshot, ref)
    if (ref.sessionId !== this.id || !record)
      throw new AppError('SCOPE_MISMATCH', '材料引用不在当前任务授权范围')
    if (record.title.startsWith('workspace:note:')) {
      const { notes } = await this.notes(signal, true)
      const note = notes.find((item) => item.record.ref.id === ref.id)
      if (!note) throw new AppError('WORKSPACE_CONFLICT', '笔记版本已变化，请使用当前引用调整驻留')
      return note.note.resident === !isNull(turns)
        ? noteEntry(note.note, note.record)
        : this.update(
            { key: note.note.key, baseRevision: note.note.revision, resident: !isNull(turns) },
            signal
          )
    }
    if (!/^script:.*:result$/u.test(record.title))
      throw new AppError('MEMORY_REFERENCE_KIND', '只有当前笔记或执行结果具有可调整的驻留租约')
    return isNull(turns)
      ? this.programs.release(ref.id, signal)
      : this.programs.retain(ref.id, turns, signal)
  }

  public async project(
    view: ModelView,
    observation: Optional<ContextRef>,
    images: readonly ModelImage[],
    signal: AbortSignal,
    maxChars: number
  ) {
    const { snapshot, reset, notes } = await this.notes(signal, true, [
      { title: 'context:projection-policy', latest: true },
      { title: 'context-maintenance:outcome', latest: true },
      { title: 'context-maintenance:request', latest: true },
      { title: 'context:delivered', latest: true },
      { titlePrefix: 'script:', titleSuffix: ':result' },
    ])
    const attemptRecord = snapshot?.records.findLast(
      (record) => record.title === 'context-maintenance:outcome' && record.sequence > reset
    )
    const outcome = attemptRecord
      ? JSON.parse((await this.storage.get(this.id, attemptRecord.objectId))!)
      : undefined
    const lastAttempt = outcome
      ? {
          requestId: toNullable(outcome.requestId),
          status: outcome.status,
          error: outcome.error,
          focus: outcome.focus,
          changes: outcome.changes,
          unresolved: outcome.unresolved,
          preserved: outcome.preserved,
          report: outcome.report,
          ref: attemptRecord!.ref,
        }
      : undefined
    const requestRecord = snapshot?.records.findLast(
      (record) => record.title === 'context-maintenance:request' && record.sequence > reset
    )
    const request = requestRecord
      ? JSON.parse((await this.storage.get(this.id, requestRecord.objectId))!)
      : undefined
    const pending =
      request?.status === 'scheduled'
        ? {
            requestId: request.requestId,
            focus: request.focus,
            preserve: request.preserve,
            boundary: 'next-model-request',
          }
        : undefined
    const presentation = await this.presentation(snapshot, reset)
    const residents = notes
      .filter((item) => item.note.resident)
      .sort((a, b) => b.record.sequence - a.record.sequence)
    const segment = await this.current(residents, presentation, maxChars, signal)
    const workspaceBudget = Math.max(
      0,
      Math.floor(maxChars * (segment.workspaceShare ?? this.policy.workspaceShare))
    )
    // 底座里是段起点的笔记快照；本帧尾只放段内改过或新驻留的笔记
    const snapshotNotes = new Map(segment.notes.map((item) => [item.key, item]))
    const changed = residents.filter(
      (item) => snapshotNotes.get(item.note.key)?.revision !== item.note.revision
    )
    const freshness = (note: WorkspaceNote) =>
      note.stamps.some((stamp) =>
        view.readSet.some(
          (current) =>
            current.sourceId === stamp.sourceId &&
            current.resourceId === stamp.resourceId &&
            (current.contentHash !== stamp.contentHash || current.revision !== stamp.revision)
        )
      )
        ? ('changed' as const)
        : ('unverified' as const)
    const cards = this.noteCards(changed, workspaceBudget, presentation)
    const workspace = cards.cards.map((card, index) => ({
      ...card,
      supersedes: toNullable(snapshotNotes.get(card.key)?.revision),
      freshness: freshness(changed[index]!.note),
    }))
    const base = await this.storage.get(this.id, segment.base.objectId)
    if (isNull(base)) throw new AppError('NOT_FOUND', '段底座正文缺失')
    const frame = await this.programs.project(
      view,
      observation,
      images,
      signal,
      Math.max(1, maxChars - base.length - cards.used)
    )
    const material = JSON.parse(frame.body)
    const sequence = new Map(
      snapshot?.records.map((record) => [record.ref.id, record.sequence]) ?? []
    )
    if (reset) {
      material.goals = material.goals.filter(
        (goal: { record: { sequence: number } }) => goal.record.sequence > reset
      )
      material.results = material.results.filter(
        (item: { ref: string }) => (sequence.get(item.ref) ?? 0) > reset
      )
    }
    // 工作帧条数限额只缩减新投影，不撤销段内已经冻结的 segment 正文。
    // 完整请求仍交给主循环核对容量；封段才一起退役这些结果。
    const squeezedSegments = frame.squeezed.length
      ? (await this.programs.state()).leases
          .filter(
            (item) =>
              item.segment &&
              frame.squeezed.includes(item.ref) &&
              (sequence.get(item.ref) ?? 0) > reset
          )
          .map((item) => ({ ref: item.ref }))
      : []
    // 一条新历史第一次交付的上限：整帧剩余预算的 recentShare 的一半
    const history = this.policy.recentRecords
      ? await this.recent.project(
          segment,
          [
            ...material.results.map((item: { location?: { executionId: string } }) => ({
              ...item,
              feedback: material.mandatory.filter(
                (feedback: ContextFeedback) => feedback.executionId === item.location?.executionId
              ),
            })),
            ...squeezedSegments,
          ],
          Math.max(
            1024,
            Math.min(
              ActRuntimeTuning.segmentEntryChars,
              Math.floor((Math.max(1, maxChars - base.length) * this.policy.recentShare) / 2)
            )
          ),
          signal
        )
      : { messages: [], items: [], fresh: [] }
    // 正文已在段内历史里的结果，本帧尾只留状态与引用；当次源码在产生它的那条响应里
    const inHistory = new Set(
      history.items
        .filter((item) => item.role === 'user' && item.bodyIncluded)
        .map((item) => item.ref)
    )
    const deliveredFeedback = new Map(
      history.items.flatMap((item) =>
        (item.feedback ?? []).map((feedback) => [feedback.fingerprint, item.ref] as const)
      )
    )
    material.results = material.results.map((item: Record<string, unknown> & { ref: string }) => {
      if (!inHistory.has(item.ref)) return item
      // 来源、大小和正文已在稳定历史；帧尾只列租约状态与尚未交付的缺口。
      // 同一个 ref 仍可经 memory.read 读取完整原文。
      return {
        ref: item.ref,
        remainingTurns: item.remainingTurns,
        bodyInHistory: true,
        bodyIncluded: true,
        ...(item.truncated
          ? {
              truncated: true,
              representation: item.representation,
              totalChars: item.totalChars,
              omitted: item.omitted,
            }
          : {}),
      }
    })
    const resultRefs = [
      ...inHistory,
      ...material.results
        .filter((item: { bodyIncluded: boolean; text?: string }) => item.bodyIncluded && item.text)
        .map((item: { ref: string }) => item.ref),
    ]
    const decision = {
      frameId: material.programFrame.id,
      missing: material.decision.missing,
    }
    await this.programs.delivered(material.programFrame.id, resultRefs, signal)
    const entries = [
      ...residents.map((item) => {
        const card = workspace.find((current) => current.key === item.note.key)
        return {
          key: `workspace:${item.note.key}`,
          ref: item.record.ref.id,
          bodyIncluded: card
            ? card.bodyIncluded
            : Boolean(snapshotNotes.get(item.note.key)?.bodyIncluded),
        }
      }),
      ...material.results.map((item: { ref: string }) => ({
        key: `result:${item.ref}`,
        ref: item.ref,
        bodyIncluded: resultRefs.includes(item.ref),
      })),
      ...(material.observation.resultRef
        ? [
            {
              key: 'observation',
              ref: material.observation.resultRef,
              bodyIncluded: Boolean(material.observation.text),
            },
          ]
        : []),
    ]
    // 因容量只给了引用的笔记和没排进本帧的租约结果；派生展示主动移出自动展示的笔记不算
    const hidden = new Set(
      presentation.active
        ? (presentation.policy?.notes ?? [])
            .filter((item) => isFalse(item.resident))
            .map((item) => item.ref.id)
        : []
    )
    const squeezed = [
      ...entries
        .filter(
          (item) => item.key.startsWith('workspace:') && !item.bodyIncluded && !hidden.has(item.ref)
        )
        .map((item) => ({ ref: item.ref, partition: 'workspace' as const })),
      ...frame.squeezed
        .filter((ref) => !inHistory.has(ref))
        .map((ref) => ({ ref, partition: 'results' as const })),
    ]
    const faultPrefix = `context:fault:${segment.id}:`
    const faults =
      (await this.snapshot(signal, [{ titlePrefix: faultPrefix }]))?.records.filter((record) =>
        record.title.startsWith(faultPrefix)
      ) ?? []
    const recentFaults = []
    for (const record of faults.slice(-ActRuntimeTuning.recentFaults)) {
      const { ref, partition } = JSON.parse((await this.storage.get(this.id, record.objectId))!)
      recentFaults.push({ ref, partition })
    }
    const last = snapshot?.records.findLast(
      (record) => record.title === 'context:delivered' && record.sequence > reset
    )
    const previous = last
      ? (JSON.parse((await this.storage.get(this.id, last.objectId))!).entries as typeof entries)
      : []
    const changes = {
      added: entries
        .filter((item) => !previous.some((old) => old.key === item.key))
        .map((item) => item.key),
      updated: entries
        .filter((item) => previous.some((old) => old.key === item.key && old.ref !== item.ref))
        .map((item) => item.key),
      exited: previous
        .filter((old) => !entries.some((item) => item.key === old.key))
        .map((item) => item.key),
      referenceOnly: entries.filter((item) => !item.bodyIncluded).map((item) => item.key),
    }
    const resetAfterStart = Boolean(
      snapshot?.records.some(
        (record) =>
          record.title === 'search:history-reset' &&
          record.sequence > (snapshot.task?.startedSequence ?? 0)
      )
    )
    // 段起点之前提出的目标已列在底座；最新和段内新提目标按剩下条数分配正文，按原始顺序进入历史。
    const recentGoals = material.goals.filter(
      (goal: ContextContent) => goal.record.sequence > segment.from
    )
    const shownGoals: ContextContent[] = isEmpty(recentGoals)
      ? material.goals.slice(-1)
      : recentGoals
    const goals =
      shownGoals.length < material.goals.length
        ? await Promise.all(
            shownGoals.map((goal) =>
              this.context.projectInput(
                goal.record.ref,
                Math.max(1, Math.floor(maxChars / Math.max(4, shownGoals.length * 4)))
              )
            )
          )
        : material.goals
    const status: SegmentStatus = {
      id: segment.id,
      index: segment.index,
      revision: segment.revision,
      volumes: segment.volumes,
      turns: history.items.filter((item) => item.role === 'assistant').length,
      faults: faults.length,
    }
    const partitions = {
      task: {
        goals: this.policy.recentRecords
          ? goals.map((goal: ContextContent) => ({ ...goal, bodyInHistory: true }))
          : goals,
        folded: { count: material.goals.length - goals.length, through: segment.from },
      },
      workspace: {
        capsule: resetAfterStart ? null : material.capsule,
        notes: workspace,
        snapshot: {
          notes: segment.notes.length,
          shown: segment.notes.filter((item) => item.shown).length,
          omitted: segment.notes.filter((item) => !item.shown).length,
          sourcesChanged: residents
            .filter(
              (item) =>
                snapshotNotes.get(item.note.key)?.revision === item.note.revision &&
                freshness(item.note) === 'changed'
            )
            .map((item) => item.note.key),
        },
        omitted: cards.omitted,
        recall: {
          module: 'velaros:system',
          export: 'memory',
          operation: 'list',
          input: { kind: 'notes' },
        },
      },
      observation: material.observation,
      // 段内历史的每条消息首行自带元数据，这里只给计数，免得本帧尾随段内轮数变长
      recent: {
        results: material.results,
        historyState: {
          segment: segment.index,
          from: segment.from,
          carried: segment.carried.length,
          records: history.items.length,
          references: history.items.filter((item) => !item.bodyIncluded).length,
          volumes: segment.volumes,
        },
      },
      runtime: {
        taskId: snapshot?.task?.id,
        decision,
        scope: material.scope,
        children: material.children,
        mandatory: memoryCommittedGroups(
          material.mandatory.map((item: ContextFeedback) => {
            const ref = deliveredFeedback.get(memoryFeedbackKey(item))
            return ref ? { ...item, detailInHistory: ref } : { ...item }
          })
        ),
        evidence: material.evidence,
        gaps: material.gaps,
        readSet: material.readSet,
        progress: material.progress,
        programFrame: material.programFrame,
        // 已成功且结果在稳定历史里的作业，只在帧尾重复完成状态；活动和失败作业保留完整信息。
        jobs: material.jobs.map(
          (job: { executionId: string; status: string; resultRef?: string }) =>
            job.status === 'succeeded' && job.resultRef && inHistory.has(job.resultRef)
              ? { executionId: job.executionId, status: job.status, resultRef: job.resultRef }
              : job
        ),
        materialStatus: material.materialStatus,
      },
    }
    const footprint = Object.fromEntries(
      Object.entries(partitions).map(([name, value]) => [name, JSON.stringify(value).length])
    )
    const body = JSON.stringify({
      schemaVersion: 2,
      id: material.id,
      frameId: material.programFrame.id,
      partitions,
      memoryStatus: {
        unit: 'utf16',
        footprint: { base: base.length, ...footprint },
        segment: {
          ...status,
          from: segment.from,
          reason: segment.reason,
          workspaceShare: segment.workspaceShare ?? this.policy.workspaceShare,
        },
        faults: isEmpty(faults)
          ? undefined
          : {
              count: faults.length,
              recent: recentFaults,
              advice:
                '这些材料上一帧因容量不够只给了引用、随后又被读回。常用的内容记进笔记，或收紧观察和结果的展示；封段时会按缺页调整笔记份额。',
            },
        changes,
        policy: this.policy,
        maintenance:
          presentation.policy || lastAttempt || pending
            ? {
                origin: presentation.policy?.origin,
                summary: presentation.policy?.summary,
                unresolved: presentation.policy?.unresolved,
                report: presentation.policy?.report,
                active: presentation.active,
                lastAttempt,
                pending,
              }
            : undefined,
        advice:
          '按当前能力合同维护工作记忆；检查分区占用、材料变化与整理回执。引用不代表正文已读。',
      },
    })
    await this.context.append(
      {
        kind: 'audit',
        title: `context:frame:${material.programFrame.id}`,
        body: JSON.stringify({
          frameId: material.programFrame.id,
          entries,
          segment: { id: segment.id, revision: segment.revision, fresh: history.fresh },
          squeezed,
        }),
        sources: [],
      },
      signal
    )
    return {
      body,
      images: resetAfterStart ? [] : frame.images,
      history: [
        { role: 'user' as const, content: base, cacheBreakpoint: true },
        ...(this.policy.recentRecords ? memoryTaskHistory(goals, history) : history.messages),
      ],
      prompt: memoryPrompt(body),
      segment: status,
    }
  }

  public async fold(
    reason: SegmentReason,
    maxChars: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const segment = await this.recent.segment(signal)
    if (!segment) return false
    const cut = await this.recent.cut(segment, this.policy.recentRecords, signal)
    if (isUndefined(cut)) return false
    const sealed = await this.recent.seal(segment.from, cut, signal)
    // 封段释放 segment 期限的旧结果；显式轮数和 task 期限继续跨段交付。
    const leases = await this.programs.state()
    const visible = leases.leases
      .filter((item) => item.task || item.segment || item.expiresAfter > leases.completedTurns)
      .map((item) => item.ref)
    const selected = await this.snapshot(
      signal,
      visible.map((refId) => ({ refId }))
    )
    const sequence = new Map(selected?.records.map((record) => [record.ref.id, record.sequence]))
    const sealedResults = visible.filter((ref) => (sequence.get(ref) ?? Infinity) <= cut)
    const retired = leases.leases
      .filter((item) => item.segment && sealedResults.includes(item.ref))
      .map((item) => item.ref)
    await this.programs.endSegment(retired, signal)
    const carried = visible
      .filter((ref) => !retired.includes(ref))
      .filter((ref) => (sequence.get(ref) ?? Infinity) <= cut)
      .sort((a, b) => sequence.get(a)! - sequence.get(b)!)
    // 自动封的一卷只有规则骨架；那一段做了很多事却没改笔记和计划时，留给整理支线补写叙事
    const volume = (await this.recent.volumes(signal)).find(
      (item) => item.ref.id === sealed.id
    )?.volume
    const narrate =
      reason !== 'organize' &&
      volume &&
      volume.turns >= ActRuntimeTuning.narrateTurns &&
      isEmpty(volume.notes) &&
      (selected?.task?.capsule?.nextObjective ?? '') === segment.objective
        ? sealed
        : null
    // 按上一段的缺页调整新段的笔记份额
    const prefix = `context:fault:${segment.id}:`
    const faults = (await this.snapshot(signal, [{ titlePrefix: prefix }]))?.records ?? []
    const count = (partition: string) =>
      faults.filter((record) => record.title === `${prefix}${partition}`).length
    const workspaceShare = adjustedWorkspaceShare(
      segment.workspaceShare ?? this.policy.workspaceShare,
      { workspace: count('workspace'), results: count('results') },
      this.policy
    )
    await this.start(
      {
        index: segment.index + 1,
        revision: 0,
        from: cut,
        carried,
        entries: [],
        reason,
        narrate,
        workspaceShare,
      },
      maxChars,
      signal
    )
    return true
  }

  public async narration(signal: AbortSignal): Promise<Nullable<ContextRef>> {
    const segment = await this.recent.segment(signal)
    if (!segment?.narrate) return null
    await this.recent.commit({ ...segment, narrate: null }, signal)
    return segment.narrate
  }

  public async boundary(signal: AbortSignal): Promise<boolean> {
    const segment = await this.recent.segment(signal)
    if (!segment) return false
    const snapshot = await this.snapshot(signal, [
      { title: 'search:history-reset', latest: true },
      { title: 'context-maintenance:request', latest: true },
    ])
    const reset = Math.max(
      snapshot?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ??
        0,
      snapshot?.task?.startedSequence ?? 0
    )
    const request = snapshot?.records.findLast(
      (record) => record.title === 'context-maintenance:request' && record.sequence > reset
    )
    return (
      (request &&
        JSON.parse((await this.storage.get(this.id, request.objectId))!).status === 'scheduled') ||
      (snapshot?.task?.goals.length ?? 0) > segment.goals ||
      (snapshot?.task?.capsule?.nextObjective ?? '') !== segment.objective
    )
  }

  /** 当前生效的投影策略；换了策略或策略过期都要重建底座。 */
  private async presentation(
    snapshot: Nullable<{ records: readonly ContextRecord[] }>,
    reset: number
  ): Promise<{
    id: Nullable<string>
    policy: Optional<ContextProjectionPolicy>
    active: boolean
  }> {
    const record = snapshot?.records.findLast(
      (item) => item.title === 'context:projection-policy' && item.sequence > reset
    )
    const policy: Optional<ContextProjectionPolicy> = record
      ? JSON.parse((await this.storage.get(this.id, record.objectId))!)
      : undefined
    const active = Boolean(
      policy &&
      (isUndefined(policy.expiresAfterTurn) ||
        (await this.programs.state()).completedTurns < policy.expiresAfterTurn)
    )
    return { id: active ? record!.ref.id : null, policy, active }
  }

  /** 笔记卡片：预算内带正文，放不下的只给引用；整理支线的派生展示优先。 */
  private noteCards(
    items: ReadonlyArray<{ note: WorkspaceNote; record: ContextRecord }>,
    budget: number,
    presentation: { policy: Optional<ContextProjectionPolicy>; active: boolean }
  ) {
    const selected = items.slice(0, Math.max(1, Math.min(64, Math.floor(budget / 1024))))
    let remaining = budget
    const cards = selected.map(({ note, record }) => {
      const shown = presentation.active
        ? presentation.policy?.notes?.find(
            (item) => item.ref.id === record.ref.id && item.ref.sessionId === this.id
          )
        : undefined
      const text = shown?.summary ?? note.body
      const included = !isFalse(shown?.resident) && text.length <= remaining
      const body = included ? text : ''
      remaining -= body.length
      return {
        ...noteEntry(note, record),
        origin: note.origin,
        sources: note.sources.slice(0, 8),
        omittedSources: Math.max(0, note.sources.length - 8),
        text: body,
        bodyIncluded: included,
        observedAt: record.createdAt,
        representation: included ? (shown?.summary ? 'summary' : 'full') : 'reference',
        ...(shown
          ? { presentationOrigin: 'model-interpretation', presentationSource: record.ref }
          : {}),
        read: {
          module: 'velaros:system',
          export: 'memory',
          operation: 'read',
          input: { ref: record.ref },
        },
      }
    })
    return { cards, omitted: items.length - selected.length, used: budget - remaining }
  }

  /** 当前段：本授权代次还没有段就开始第 1 段；快照笔记移出、策略变化或段内改动过多时重建底座。 */
  private async current(
    residents: ReadonlyArray<{ note: WorkspaceNote; record: ContextRecord }>,
    presentation: { id: Nullable<string> },
    maxChars: number,
    signal: AbortSignal
  ): Promise<ContextSegment> {
    const segment = await this.recent.segment(signal)
    if (!segment) {
      const from = await this.recent.migrate(signal)
      return this.start(
        { index: 1, revision: 0, from, carried: [], entries: [], reason: 'start' },
        maxChars,
        signal
      )
    }
    const current = new Map(residents.map((item) => [item.note.key, item.note]))
    const drift = residents
      .filter(
        (item) =>
          segment.notes.find((known) => known.key === item.note.key)?.revision !==
          item.note.revision
      )
      .reduce((sum, item) => sum + item.note.body.length, 0)
    if (
      segment.notes.some((item) => !current.has(item.key)) ||
      segment.policy !== presentation.id ||
      drift > (maxChars * (segment.workspaceShare ?? this.policy.workspaceShare)) / 4
    )
      return this.start(
        { ...segment, revision: segment.revision + 1, reason: 'rebase' },
        maxChars,
        signal
      )
    return segment
  }

  /** 渲染并登记一段的底座；重建底座时沿用段号、起点、条目和章节基准。 */
  private async start(
    input: Pick<ContextSegment, 'index' | 'revision' | 'from' | 'carried' | 'entries' | 'reason'> &
      Partial<Pick<ContextSegment, 'id' | 'objective' | 'goals' | 'narrate' | 'workspaceShare'>>,
    maxChars: number,
    signal: AbortSignal
  ): Promise<ContextSegment> {
    const { snapshot, reset, notes } = await this.notes(signal, true, [
      { title: 'context:projection-policy', latest: true },
      { kind: 'user' },
    ])
    const presentation = await this.presentation(snapshot, reset)
    const residents = notes
      .filter((item) => item.note.resident)
      .sort((a, b) => b.record.sequence - a.record.sequence)
    const volumes = await this.recent.volumes(signal)
    const workspaceShare = input.workspaceShare ?? this.policy.workspaceShare
    const cards = this.noteCards(
      residents,
      Math.max(0, Math.floor(maxChars * workspaceShare)),
      presentation
    )
    // 输入摘要里的约束进长期单；段起点之前提出的目标只在底座列第一行，最新的在前
    const sequences = new Map(
      snapshot?.records
        .filter((record) => record.kind === 'user')
        .map((record) => [record.ref.id, record.sequence])
    )
    const taskGoals = (snapshot?.task?.goals ?? [])
      .filter((ref) => (sequences.get(ref.id) ?? 0) > reset)
      .reverse()
    const summaries = new Map(
      snapshot?.inputSummaries?.map((item) => [item.input.id, item.summary])
    )
    const constraints = []
    for (const ref of taskGoals) {
      const summary = summaries.get(ref.id)
      if (!summary) continue
      const intent = archivedJson(
        (await this.context.read(summary, { limit: ContextLimits.readChars })).text
      )
      constraints.push({
        ref: summary,
        items: isArray(intent.constraints) ? intent.constraints.filter(isString) : [],
      })
    }
    const earlier = taskGoals.filter((ref) => sequences.get(ref.id)! <= input.from)
    const listed: Array<FoldedGoals['items'][number]> = []
    for (const ref of earlier.slice(0, ActRuntimeTuning.foldedGoals)) {
      const content = await this.context.readInput(ref, {
        limit: ActRuntimeTuning.volumeLineChars,
      })
      listed.push({
        ref,
        sequence: content.record.sequence,
        line: skeletonLine(content.text.split('\n')[0] ?? ''),
        summaryRef: toNullable(summaries.get(ref.id)),
      })
    }
    const text = segmentBase({
      index: input.index,
      from: input.from,
      volumes,
      ledgers: segmentLedgers(await this.recent.narratives(signal), constraints),
      goals: { items: listed, omitted: earlier.length - listed.length },
      notes: cards.cards,
      omitted: cards.omitted,
    })
    const segment: ContextSegment = {
      id: input.id ?? crypto.randomUUID(),
      index: input.index,
      revision: input.revision,
      from: input.from,
      base: { objectId: await this.storage.put(this.id, text), chars: text.length },
      carried: input.carried,
      notes: residents.map(({ note, record }) => {
        const card = cards.cards.find((item) => item.key === note.key)
        return {
          key: note.key,
          revision: note.revision,
          ref: record.ref.id,
          shown: Boolean(card),
          bodyIncluded: Boolean(card?.bodyIncluded),
        }
      }),
      entries: input.entries,
      objective: input.objective ?? snapshot?.task?.capsule?.nextObjective ?? '',
      goals: input.goals ?? snapshot?.task?.goals.length ?? 0,
      policy: presentation.id,
      volumes: volumes.length,
      reason: input.reason,
      narrate: toNullable(input.narrate),
      workspaceShare,
    }
    await this.recent.commit(segment, signal)
    return segment
  }

  public async acknowledge(frameId: string, signal: AbortSignal): Promise<void> {
    const selected = this.storage.selectSnapshot
      ? await this.storage.selectSnapshot(this.id, [
          { title: `context:frame:${frameId}`, latest: true },
          { title: 'context:delivered', latest: true },
        ])
      : undefined
    const snapshot = this.storage.selectSnapshot ? selected : await this.storage.load(this.id)
    signal.throwIfAborted()
    const frame = snapshot?.records.findLast(
      (record) => record.title === `context:frame:${frameId}`
    )
    if (!frame) throw new AppError('NOT_FOUND', '上下文帧尚未登记')
    const previous = snapshot?.records.findLast((record) => record.title === 'context:delivered')
    if (
      previous &&
      JSON.parse((await this.storage.get(this.id, previous.objectId))!).frameId === frameId
    )
      return
    const body = (await this.storage.get(this.id, frame.objectId))!
    // 本帧第一次交付的段内历史从此冻结，同段后续帧逐字复用
    const delivered = JSON.parse(body).segment as Optional<{
      id: string
      revision: number
      fresh: ContextSegment['entries']
    }>
    if (delivered?.fresh.length) {
      const segment = await this.recent.segment(signal)
      if (segment?.id === delivered.id && segment.revision === delivered.revision) {
        const known = new Set(segment.entries.map((entry) => entry.ref))
        await this.recent.commit(
          {
            ...segment,
            entries: [
              ...segment.entries,
              ...delivered.fresh.filter((entry) => !known.has(entry.ref)),
            ],
          },
          signal
        )
      }
    }
    await this.context.append(
      { kind: 'audit', title: 'context:delivered', body, sources: [frame.ref] },
      signal
    )
  }
}
