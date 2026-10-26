import type {
  ContextCompletionRecord,
  ContextContent,
  ContextFeedback,
  ContextInvocationJournalApi,
  ContextRecord,
  ContextRecordSelection,
  ContextRef,
  ContextRuntime,
  ContextStorage,
  ContextViewApi,
  ModelView,
} from '@velaros-ai/context'
import { createContextReference } from '@velaros-ai/context'
import { isEmpty } from '@velaros-ai/core'
import { isFalse, isNull, isTrue, isUndefined, toNullable } from '@velaros-ai/core'
import { isArray, isBoolean, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelHistoryMessage, ModelImage, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { scriptOutputs } from '@velaros-ai/script'
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
  MemoryReadDelivery,
  RuntimeNoteContent,
  RuntimeNoteRead,
  WorkspaceNote,
} from '../types/memory.js'
import type { ScriptDecisionBasis } from '../types/runtime.js'
import type {
  ContextSegment,
  FoldedGoals,
  SegmentOutputProof,
  SegmentOutputView,
  SegmentReason,
  SegmentStatus,
} from '../types/segment.js'
import {
  adjustedWorkspaceShare,
  memoryCommittedGroups,
  memoryDeliveredOutputs,
  memoryFeedbackKey,
  memoryMaterialKind,
  memoryMessageKey,
  memoryOutput,
  memoryOutputRefs,
  memoryPolicy,
  memoryPrompt,
  memoryProofCarriers,
  memoryReference,
  memoryTaskHistory,
  memoryVerificationProjection,
  noteEntry,
} from '../utils/context-memory.js'
import { decisionStateProjection } from '../utils/decision-state.js'
import { executionMaterial, materialHistoryDelta, readMaterialField } from '../utils/materials.js'
import { segmentBase, skeletonLine } from '../utils/segment.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

import { ActiveContext } from './ActiveContext.js'
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
    pointer?: string,
    invocation?: string
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
  acknowledge(
    frameId: string,
    signal: AbortSignal,
    request?: ModelTurnRequest
  ): Promise<Optional<ScriptDecisionBasis>>
  /** 最终历史已选择后核对正文证明；候选证明直到接受响应才绑定实际消息。 */
  reconcile(
    body: string,
    history: readonly ModelHistoryMessage[],
    previous: Optional<string>,
    signal: AbortSignal
  ): Promise<{ body: string; prompt: string }>
  /** 把段内较早的历史封成一卷并开始新的一段，不调用模型；能封的不足一个响应时返回 false。 */
  fold(reason: SegmentReason, maxChars: number, signal: AbortSignal): Promise<boolean>
  /**
   * 容量不足时把租约已结束、仍冻结在段内历史里的结果正文退成引用卡；不封卷，请求前缀从第一处改写起失效。
   * 没有可退的正文时返回 false。
   */
  retire(signal: AbortSignal): Promise<boolean>
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
    policy?: ContextMemoryPolicy,
    private readonly journal?: ContextInvocationJournalApi
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

  /** 当前目标跨任务保持可读，与 goal.get 的范围一致；历史版本仍沿用材料授权。 */
  private async materialSnapshot(ref: ContextRef, signal: AbortSignal) {
    const snapshot = await this.snapshot(signal, [
      { title: 'search:history-reset', latest: true },
      { title: 'session:goal', latest: true },
      { kind: 'user' },
      { refId: ref.id },
    ])
    const currentGoal = snapshot?.records.findLast((item) => item.title === 'session:goal')
    const record =
      memoryReference(snapshot, ref) ??
      (ref.sessionId === this.id && currentGoal?.kind === 'audit' && currentGoal.ref.id === ref.id
        ? currentGoal
        : undefined)
    return { snapshot, record }
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
        ref: await createContextReference(this.storage, this.id),
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
      const kind = memoryMaterialKind(record, record.sequence <= reset)
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
    pointer?: string,
    invocation?: string
  ): Promise<MemoryContent> {
    const ref = isString(value) ? { sessionId: this.id, id: value } : value
    const { snapshot, record } = await this.materialSnapshot(ref, signal)
    if (ref.sessionId !== this.id || !record)
      throw new AppError('SCOPE_MISMATCH', '材料引用不在当前任务授权范围')
    await this.fault(ref, signal)
    const result = /^script:[^:]+:result$/u.test(record.title ?? '')
    const stateDetails = record.title.startsWith('context:decision-state:')
    const goal = record.kind === 'audit' && record.title === 'session:goal'
    if (!isUndefined(invocation)) {
      if (!result || !isString(invocation) || !invocation)
        throw new AppError('VALIDATION', '调用召回必须指定失败执行结果及其调用身份')
      const archived = await this.storage.get(this.id, record.objectId)
      if (isNull(archived)) throw new AppError('NOT_FOUND', '执行结果原文不可用')
      const saved = JSON.parse(archived)
      if (
        record.title !== `script:${saved.executionId}:result` ||
        !saved.recovery?.calls?.some((call: { id: string }) => call.id === invocation)
      )
        throw new AppError('SCOPE_MISMATCH', '调用不在该失败执行的召回索引中')
      if (!this.journal) throw new AppError('UNAVAILABLE', '当前宿主不支持调用回执召回')
      const call = await this.journal.read(this.id, invocation)
      signal.throwIfAborted()
      // 日志读取可能跨越授权重置；返回前重新核对同一不可变结果的当前授权。
      const current = memoryReference(
        await this.snapshot(signal, [
          { title: 'search:history-reset', latest: true },
          { kind: 'user' },
          { refId: ref.id },
        ]),
        ref
      )
      if (!current || current.objectId !== record.objectId)
        throw new AppError('SCOPE_MISMATCH', '材料引用不在当前任务授权范围')
      if (
        !call ||
        call.prepared.sessionId !== this.id ||
        call.prepared.executionId !== saved.executionId ||
        call.prepared.id !== invocation ||
        (call.receipt && JSON.stringify(call.receipt.invocation) !== JSON.stringify(call.prepared))
      )
        throw new AppError('SCOPE_MISMATCH', '原始调用身份与失败执行不一致')
      if (call.phase !== 'settled' || !call.receipt)
        throw new AppError('UNAVAILABLE', '调用尚无落定回执，outcome=unknown；不会重跑')
      const receipt = JSON.stringify(call.receipt)
      const page = isUndefined(pointer)
        ? readMaterialField(JSON.stringify({ receipt: call.receipt }), '/receipt', offset, limit)
        : readMaterialField(receipt, pointer, offset, limit)
      const content: ContextContent & { pointer?: string; invocation?: string } = {
        record,
        text: page.text,
        offset: page.offset,
        totalChars: page.totalChars,
      }
      if (!isUndefined(pointer)) content.pointer = pointer
      content.invocation = invocation
      return content
    }
    if (!isUndefined(pointer) || result || stateDetails || goal) {
      if (!result && !stateDetails && !goal)
        throw new AppError('VALIDATION', '字段召回仅适用于执行结果、目标或当前决策状态归档')
      const archived = await this.storage.get(this.id, record.objectId)
      signal.throwIfAborted()
      if (isNull(archived)) throw new AppError('NOT_FOUND', '材料原文不可用')
      const page: MemoryContent = isUndefined(pointer)
        ? await this.context.read(ref, { offset, limit })
        : { record, ...readMaterialField(archived, pointer, offset, limit) }
      // 目标与状态细节召回定位原文，不签发执行输出的 required 送达证明。
      if (stateDetails || goal) {
        const current = await this.materialSnapshot(ref, signal)
        if (!current.record || current.record.objectId !== record.objectId)
          throw new AppError('SCOPE_MISMATCH', '召回期间材料的授权范围已经变化')
        return page
      }
      const match = pointer?.match(/^\/output\/blocks\/(0|[1-9]\d*)\/value$/u)
      const blocks = (JSON.parse(archived).output?.blocks ?? []) as Array<{
        key: string
        value: unknown
        options: { required?: boolean }
      }>
      const selected = isUndefined(pointer)
        ? blocks
        : match
          ? blocks.slice(Number(match[1]), Number(match[1]) + 1)
          : []
      const required = selected.filter((block) => block.options.required)
      if (isEmpty(required)) return page
      const pointerFields: { pointer?: string } = {}
      if (!isUndefined(pointer)) pointerFields.pointer = pointer
      const delivery: MemoryReadDelivery = {
        authorizationSequence: Math.max(
          snapshot?.task?.startedSequence ?? 0,
          snapshot?.records.findLast((item) => item.title === 'search:history-reset')?.sequence ?? 0
        ),
        source: ref,
        blocks: required.map((block) => ({
          key: block.key,
          contentHash: scriptOutputs.hash(block.value),
        })),
        ...pointerFields,
        offset: page.offset,
        chars: page.text.length,
        totalChars: page.totalChars,
        pageHash: scriptOutputs.hash(page),
      }
      const receipt = await this.context.append(
        {
          kind: 'audit',
          title: 'memory:read-delivery',
          body: JSON.stringify(delivery),
          sources: [ref],
        },
        signal
      )
      return { ...page, delivery: { receipt: receipt.ref } }
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
  ): ReturnType<ContextMemoryApi['project']> {
    return this.projectFrame(view, observation, images, signal, maxChars, true)
  }

  private async projectFrame(
    view: ModelView,
    observation: Optional<ContextRef>,
    images: readonly ModelImage[],
    signal: AbortSignal,
    maxChars: number,
    reuseRetained: boolean
  ): ReturnType<ContextMemoryApi['project']> {
    const active = await new ActiveContext(this.id, this.context, this.storage).read(signal)
    const programState = await this.programs.state()
    const { snapshot, reset, notes } = await this.notes(signal, true, [
      { title: 'context:projection-policy', latest: true },
      { title: 'context-maintenance:outcome', latest: true },
      { title: 'context-maintenance:request', latest: true },
      { title: 'context:delivered', latest: true },
      { titlePrefix: 'task:completion:', latest: true },
      { titlePrefix: 'context:decision-state:', latest: true },
      ...programState.leases
        .filter(
          (item) => item.task || item.segment || item.expiresAfter > programState.completedTurns
        )
        .map((item) => ({ refId: item.ref })),
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
    const segment = await this.retireEntries(
      await this.current(residents, presentation, maxChars, signal),
      'released',
      signal
    )
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
    // 当前身份目录独立于段底座和正文预算；超出展示上限的条目用明确缺口与分页目录召回。
    const directoryLimit = Math.max(1, Math.min(64, Math.floor(workspaceBudget / 512)))
    const residentDirectory = {
      items: residents.slice(0, directoryLimit).map(({ note, record }) => ({
        key: note.key,
        revision: note.revision,
        ref: record.ref,
        freshness: freshness(note),
        bodyLocation:
          snapshotNotes.get(note.key)?.revision === note.revision &&
          snapshotNotes.get(note.key)?.shown
            ? 'segment-base'
            : cards.cards.some((card) => card.key === note.key && card.bodyIncluded)
              ? 'frame-tail'
              : 'recall',
      })),
      omitted: Math.max(0, residents.length - directoryLimit),
    }
    const completionRecord = snapshot?.task?.completionRef
      ? memoryReference(snapshot, snapshot.task.completionRef)
      : undefined
    const completion: Optional<ContextCompletionRecord> = completionRecord
      ? JSON.parse((await this.storage.get(this.id, completionRecord.objectId))!)
      : undefined
    const report = completion?.result.report
    const verification: Optional<Record<string, unknown>> =
      completion && completion.taskId === snapshot?.task?.id
        ? {
            ref: completionRecord!.ref,
            taskId: completion.taskId,
            taskRevision: completion.taskRevision,
            binding: completion.binding,
            completed: completion.result.completed,
            verified: completion.result.verified,
            counts: Object.fromEntries(
              ['passed', 'failed', 'unknown'].map((status) => [
                status,
                report?.checks.filter((check) => check.status === status).length ?? 0,
              ])
            ),
            checkedAt: report?.checkedAt,
            checks: [],
            omittedChecks: report?.checks.length ?? 0,
          }
        : undefined
    if (verification && report) {
      const applicability = await this.view.completionApplicability(completionRecord!.ref, signal)
      verification.applicabilityCheckedAt = applicability?.checkedAt
      // 原核查结果和当前适用性分别计数；细节预算不能把历史证明或未知依赖隐藏成当前成功。
      verification.applicabilityCounts = Object.fromEntries(
        ['current', 'historical', 'unknown'].map((status) => [
          status,
          report.checks.filter(
            (_check, index) => (applicability?.checks[index]?.status ?? 'unknown') === status
          ).length,
        ])
      )
      // 核查摘要只占帧预算的一小份；大范围和产物细节按报告引用回看，修复帧始终留给当前状态。
      const verificationBudget = Math.min(2048, Math.max(0, Math.floor(maxChars / 40)))
      Object.assign(
        verification,
        memoryVerificationProjection(verification, report, applicability, verificationBudget)
      )
    }
    const workspace = cards.cards.map((card, index) => ({
      ...card,
      supersedes: toNullable(snapshotNotes.get(card.key)?.revision),
      freshness: freshness(changed[index]!.note),
    }))
    const base = await this.storage.get(this.id, segment.base.objectId)
    if (isNull(base)) throw new AppError('NOT_FOUND', '段底座正文缺失')
    const records = new Map(snapshot?.records.map((record) => [record.ref.id, record]) ?? [])
    // 仅把本次历史仍会保留的冻结执行正文用于额度分配；当前授权与段携入边界同历史读取器。
    const retained =
      reuseRetained && this.policy.recentRecords
        ? segment.entries.filter((entry) => {
            const record = records.get(entry.ref)
            return Boolean(
              entry.role === 'user' &&
              (entry.outputViews || entry.fullMaterial) &&
              record &&
              record.sequence > reset &&
              (record.sequence > segment.from || segment.carried.includes(entry.ref)) &&
              /^script:(?:[a-f0-9]{8}|[0-9a-f-]{36}):result$/u.test(record.title)
            )
          })
        : []
    const frame = await this.programs.project(
      view,
      observation,
      images,
      signal,
      Math.max(1, maxChars - base.length - cards.used),
      retained
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
    const squeezedSegments = !isEmpty(frame.squeezed)
      ? (await this.programs.state()).leases
          .filter(
            (item) =>
              item.segment &&
              frame.squeezed.includes(item.ref) &&
              (sequence.get(item.ref) ?? 0) > reset
          )
          .map((item) => ({ ref: item.ref }))
      : []
    // 已在当前结果池内分配的正文完整进入历史，避免把合法 JSON 再切成半截。
    // 普通历史保留 recentShare 的基准；整体请求仍由模型输入预算核对。
    const historyEntryChars = Math.max(
      1024,
      Math.min(
        ActRuntimeTuning.segmentEntryChars,
        Math.max(
          Math.floor((Math.max(1, maxChars - base.length) * this.policy.recentShare) / 2),
          ...material.results.map((item: { text?: string }) => item.text?.length ?? 0)
        )
      )
    )
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
          historyEntryChars,
          signal
        )
      : { messages: [], items: [], fresh: [] }
    // 准备期间的授权重置或历史退役可能使预分配所依据的正文失效。
    // 重新读取当前快照并完整投影一次，恢复正文与额度，不能只撤掉展示标记。
    if (
      retained.some(
        (entry) =>
          !history.items.some(
            (item) =>
              item.ref === entry.ref &&
              item.role === 'user' &&
              item.bodyIncluded &&
              (!entry.fullMaterial || item.fullMaterial === entry.fullMaterial) &&
              (entry.outputViews ?? []).every((previous) =>
                item.outputViews?.some(
                  (current) =>
                    current.key === previous.key && current.fingerprint === previous.fingerprint
                )
              )
          )
      )
    )
      return this.projectFrame(view, observation, images, signal, maxChars, false)
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
    // 只复用本次实际历史正文的完整块证明，不将曾经展示或同字串视为原文送达。
    const outputProofs = history.items.flatMap((item) =>
      item.role === 'user' && item.bodyIncluded
        ? (item.outputProofs ?? []).filter((proof) => (proof.carrierRef ?? proof.ref) === item.ref)
        : []
    )
    const deliveredOutputs = new Set(
      outputProofs
        .filter((proof) => !proof.range)
        .map((proof) => JSON.stringify([proof.ref, proof.key, proof.contentHash]))
    )
    const recalledOutputs = new Set<string>()
    const ranges = new Map<string, SegmentOutputProof[]>()
    for (const proof of outputProofs) {
      if (!proof.range) continue
      const key = JSON.stringify([
        proof.ref,
        proof.key,
        proof.contentHash,
        proof.range.pointer,
        proof.range.totalChars,
      ])
      const group = ranges.get(key)
      if (group) group.push(proof)
      else ranges.set(key, [proof])
    }
    for (const group of ranges.values()) {
      const first = group[0]!
      let through = 0
      for (const proof of group.sort((left, right) => left.range!.offset - right.range!.offset)) {
        if (proof.range!.offset > through) break
        through = Math.max(through, proof.range!.offset + proof.range!.chars)
      }
      if (through === first.range!.totalChars) {
        const identity = JSON.stringify([first.ref, first.key, first.contentHash])
        deliveredOutputs.add(identity)
        recalledOutputs.add(identity)
      }
    }
    const historyOutputs = new Map(
      history.items
        .filter((item) => item.role === 'user' && item.bodyIncluded && item.outputFingerprint)
        .map((item) => [item.ref, item.outputFingerprint])
    )
    const fullMaterials = new Map(
      history.items
        .filter((item) => item.role === 'user' && item.bodyIncluded && item.fullMaterial)
        .map((item) => [item.ref, item.fullMaterial])
    )
    const historyViews = new Map(
      history.items
        .filter((item) => item.role === 'user' && item.bodyIncluded && item.outputViews)
        .map((item) => [item.ref, item.outputViews!])
    )
    const workingProofs = new Map<string, readonly SegmentOutputProof[]>(
      material.results.map(
        (item: { ref: string; outputProofs?: readonly SegmentOutputProof[] }) => [
          item.ref,
          item.outputProofs ?? [],
        ]
      )
    )
    const workingTexts = new Map<string, string>(
      material.results.map((item: { ref: string; text?: string }) => [item.ref, item.text ?? ''])
    )
    const rawDeltas = new Map<string, string>()
    for (const item of material.results) {
      if (item.structuredOutput || !item.materialCoverage || !item.text) continue
      const index = history.items.findIndex(
        (entry) => entry.ref === item.ref && entry.role === 'user' && entry.bodyIncluded
      )
      const entry = history.items[index]
      const content = history.messages[index]?.content
      const record = records.get(item.ref)
      if (!entry?.outputFingerprint || !isString(content) || !record) continue
      const marker = '\n当次输出：\n'
      const boundary = content.lastIndexOf(marker)
      if (boundary < 0) continue
      const previous = content.slice(boundary + marker.length)
      const identity = [this.id, item.ref, toNullable(item.sourceRef)]
      if (
        entry.outputFingerprint !== scriptOutputs.hash([...identity, previous]) ||
        entry.outputFingerprint === scriptOutputs.hash([...identity, item.text])
      )
        continue
      const archived = await this.storage.get(this.id, record.objectId)
      if (!archived) continue
      const original = executionMaterial(JSON.parse(archived))
      if (item.materialCoverage.identity !== scriptOutputs.hash([...identity, original])) continue
      const reduced = materialHistoryDelta(original, item.text, previous, record.ref)
      if (reduced) rawDeltas.set(item.ref, reduced)
    }
    material.results = material.results.map((item: Record<string, unknown> & { ref: string }) => {
      const { outputProofs: _outputProofs, outputViews, materialCoverage, ...displayed } = item
      const coverage = frame.outputCoverage?.find((coverage) => coverage.ref === item.ref)
      if (coverage) {
        const currentViews = (outputViews ?? []) as readonly SegmentOutputView[]
        const retainedViews = historyViews.get(item.ref) ?? []
        const delivered = coverage.projection.blocks.filter(
          (block) =>
            (coverage.keys.includes(block.key) &&
              recalledOutputs.has(JSON.stringify([item.ref, block.key, block.contentHash]))) ||
            currentViews.some(
              (current) =>
                current.key === block.key &&
                retainedViews.some(
                  (retained) =>
                    retained.key === current.key && retained.fingerprint === current.fingerprint
                )
            )
        )
        const reduced = scriptOutputs.withoutBodies(coverage.projection, delivered)
        if (reduced !== coverage.projection) {
          displayed.text = reduced.prompt
          // 只变展示正文；原引用、缺口与未覆盖块仍由原合同处理。
          displayed.bodyIncluded = reduced.blocks.some((block) => block.bodyIncluded)
          displayed.representation = displayed.bodyIncluded ? 'excerpt' : 'reference'
          displayed.truncated = true
          if (
            !reduced.omittedBlocks &&
            reduced.blocks.every((block) => block.reason === 'body-in-history')
          )
            displayed.bodyInHistory = true
        }
      }
      if (!inHistory.has(item.ref)) return displayed
      const text = isString(item.text) ? item.text : ''
      const encoded =
        item.structuredOutput && text
          ? memoryOutput(text, item.outputFormat === 'text' ? 'text' : 'json')
          : text
      const fullMaterial = fullMaterials.get(item.ref)
      if (
        !isTrue(item.bodyInHistory) &&
        !(
          !item.structuredOutput &&
          fullMaterial &&
          materialCoverage &&
          fullMaterial === (materialCoverage as { identity: string }).identity
        ) &&
        historyOutputs.get(item.ref) !==
          scriptOutputs.hash([this.id, item.ref, toNullable(item.sourceRef), encoded])
      )
        return rawDeltas.has(item.ref)
          ? {
              ...displayed,
              text: rawDeltas.get(item.ref),
              representation: 'excerpt',
              truncated: true,
            }
          : displayed
      // 同一来源的本次编码表示已经逐字进入历史；表示的截断状态与原值缺口独立保留。
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
      missing: material.decision.missing
        .filter(
          (item: Partial<SegmentOutputProof> & { reason: string }) =>
            !['required-body-unavailable', 'required-lease-not-delivered'].includes(item.reason) ||
            !item.contentHash ||
            !deliveredOutputs.has(JSON.stringify([item.ref, item.key, item.contentHash]))
        )
        .map((item: { contentHash?: string }) => {
          const { contentHash: _contentHash, ...gap } = item
          return gap
        }),
    }
    if (decision.missing.some((item: { read?: unknown }) => item.read))
      Object.assign(decision, {
        recall:
          '必需输出补齐：用 missing[].read 作为 memory.read 输入，从 offset 0 开始；每页以 page.offset + page.text.length 续读，到该页返回的 page.totalChars 停止。每页原样 output(page, {key:唯一键,view:{mode:"full"}})。可在一次 execute 中逐页输出；只有本次模型历史实际完整保留的页连续覆盖该表示全文才满足。局部字段、裸 page.text、未展示完的页与初始摘录不计入覆盖；展示额度不足时分批读取，不自动 release。',
      })
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
    let goals =
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
    // 最新原始输入优先使用本次投影上限；按四分之一份额重截会在空间仍足够时改写历史前缀。
    // 完整请求仍由循环核算容量，必要时以更小的投影上限重建；摘要不能替换当前输入身份。
    const latestGoal = goals.at(-1) as ContextContent | undefined
    if (latestGoal)
      goals = [
        ...goals.slice(0, -1),
        {
          ...latestGoal,
          ...(await this.context.projectInput(
            latestGoal.record.ref,
            Math.max(1, Math.floor(maxChars)),
            true
          )),
        },
      ]
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
        active,
        goals: this.policy.recentRecords
          ? goals.map((goal: ContextContent) => ({ ...goal, bodyInHistory: true }))
          : goals,
        folded: { count: material.goals.length - goals.length, through: segment.from },
      },
      workspace: {
        capsule: resetAfterStart ? null : material.capsule,
        notes: workspace,
        residentDirectory,
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
      // 结果历史首行带元数据，assistant 历史保留原文；这里仅给计数，引用由历史账持有。
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
        verification,
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
    const stateBudget = Math.max(
      1,
      Math.min(ActRuntimeTuning.stateChars, Math.floor(maxChars * ActRuntimeTuning.stateShare))
    )
    const stateProjection =
      this.policy.stateDetails === 'budgeted'
        ? decisionStateProjection(partitions.runtime, active, stateBudget)
        : undefined
    // 仅在细节确实可减少时归档原文；原内部帧与正文证明保持完整。
    let stateRecord: Optional<ContextRecord>
    if (stateProjection && stateProjection.savedChars > ActRuntimeTuning.stateMinimumSavings) {
      const title = `context:decision-state:${snapshot?.task?.id ?? 'none'}:${reset}`
      const detail = JSON.stringify({
        readSet: partitions.runtime.readSet,
        evidence: partitions.runtime.evidence,
        progress: partitions.runtime.progress,
      })
      const previous = snapshot?.records.findLast(
        (record) => record.title === title && record.sequence > reset
      )
      stateRecord =
        previous && (await this.storage.get(this.id, previous.objectId)) === detail
          ? previous
          : await this.context.append({ kind: 'audit', title, body: detail }, signal)
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
        decisionState:
          stateProjection && (stateRecord || stateProjection.originalChars > stateBudget)
            ? {
                ref: stateRecord?.ref,
                budget: stateBudget,
                originalChars: stateProjection.originalChars,
                shownChars: stateRecord
                  ? stateProjection.shownChars
                  : stateProjection.originalChars,
                savedChars: stateRecord ? stateProjection.savedChars : 0,
                overBudget:
                  (stateRecord ? stateProjection.shownChars : stateProjection.originalChars) >
                  stateBudget,
              }
            : undefined,
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
          budget: { maxChars, program: frame.budget, historyEntryChars },
          entries,
          segment: { id: segment.id, revision: segment.revision, fresh: history.fresh },
          proof: {
            authorization: reset,
            missing: material.decision.missing,
            history: history.items.flatMap((item, index) =>
              item.role === 'user' && item.bodyIncluded && item.outputProofs?.length
                ? [
                    {
                      message: memoryMessageKey(history.messages[index]!),
                      proofs: item.outputProofs,
                    },
                  ]
                : []
            ),
            current: material.results.flatMap(
              (item: { ref: string; text?: string; outputFormat?: string }) => {
                const proofs = workingProofs.get(item.ref)
                return item.text && item.text === workingTexts.get(item.ref) && proofs?.length
                  ? [
                      {
                        ref: item.ref,
                        text: scriptOutputs.hash([item.ref, item.outputFormat, item.text]),
                        proofs,
                      },
                    ]
                  : []
              }
            ),
          },
          squeezed,
        }),
        sources: [],
      },
      signal
    )
    return {
      body,
      images: resetAfterStart ? [] : frame.images,
      history: this.policy.recentRecords
        ? memoryTaskHistory(goals, history, base)
        : [{ role: 'user' as const, content: base, cacheBreakpoint: true }, ...history.messages],
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
      (volume.turns >= ActRuntimeTuning.narrateTurns ||
        volume.results >= ActRuntimeTuning.narrateResults) &&
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

  public async retire(signal: AbortSignal): Promise<boolean> {
    const segment = await this.recent.segment(signal)
    return Boolean(segment) && (await this.retireEntries(segment!, 'expired', signal)) !== segment
  }

  /**
   * 租约自然结束的冻结结果正文平时逐字保留到封段，请求只往后加；容量不足时（expired）一次性全部退成
   * 引用卡，显式释放的（released）随下一次投影退成引用卡。不需要改写时原样返回当前段。
   */
  private async retireEntries(
    segment: ContextSegment,
    scope: 'expired' | 'released',
    signal: AbortSignal
  ): Promise<ContextSegment> {
    const leases = await this.programs.state()
    const visible = new Set(
      leases.leases
        .filter((item) => item.task || item.segment || item.expiresAfter > leases.completedTurns)
        .map((item) => item.ref)
    )
    const released = new Set(leases.released ?? [])
    const retired = segment.entries.filter(
      (entry) =>
        entry.role === 'user' &&
        !visible.has(entry.ref) &&
        (scope === 'expired' || released.has(entry.ref))
    )
    if (isEmpty(retired)) return segment
    const next = {
      ...segment,
      revision: segment.revision + 1,
      entries: segment.entries.filter((entry) => !retired.includes(entry)),
      reason: 'retire' as const,
    }
    await this.recent.commit(next, signal)
    return next
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
      const from = await this.recent.currentBoundary(signal)
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
      ledgers: {
        ...(await this.recent.ledgers(signal)),
        constraints: { items: [], omitted: 0, sources: [] },
        unresolved: { items: [], omitted: 0, sources: [] },
      },
      goals: { items: listed, omitted: earlier.length - listed.length },
      notes: cards.cards,
      omitted: cards.omitted,
    })
    const base = await this.context.append(
      {
        kind: 'audit',
        title: 'context:segment-body',
        body: text,
        sources: [],
      },
      signal
    )
    const segment: ContextSegment = {
      id: input.id ?? (await createContextReference(this.storage, this.id)).id,
      index: input.index,
      revision: input.revision,
      from: input.from,
      base: { objectId: base.objectId, chars: text.length },
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

  /** 证明始终服从当前授权、段身份和载体释放；不可变原文不靠相同文字重新授权。 */
  private async authorizedProofs(
    proofs: readonly SegmentOutputProof[],
    authorization: number,
    segment: { id: string; revision: number },
    signal: AbortSignal
  ): Promise<readonly SegmentOutputProof[]> {
    const refs = [...new Set(proofs.flatMap((proof) => [proof.ref, proof.carrierRef ?? proof.ref]))]
    const state = await this.snapshot(signal, [
      { title: 'search:history-reset', latest: true },
      { kind: 'user' },
      ...refs.map((refId) => ({ refId })),
    ])
    const reset = Math.max(
      state?.task?.startedSequence ?? 0,
      state?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ?? 0
    )
    const current = await this.recent.segment(signal)
    if (
      reset !== authorization ||
      current?.id !== segment.id ||
      current.revision !== segment.revision
    )
      return []
    const released = new Set((await this.programs.state()).released ?? [])
    return proofs.filter(
      (proof) =>
        !released.has(proof.carrierRef ?? proof.ref) &&
        memoryReference(state, { sessionId: this.id, id: proof.ref }) &&
        memoryReference(state, { sessionId: this.id, id: proof.carrierRef ?? proof.ref })
    )
  }

  public async reconcile(
    body: string,
    history: readonly ModelHistoryMessage[],
    previous: Optional<string>,
    signal: AbortSignal
  ): Promise<{ body: string; prompt: string }> {
    const projected = JSON.parse(body)
    const selected = await this.snapshot(signal, [
      { title: `context:frame:${projected.frameId}`, latest: true },
      { title: 'context:delivered', latest: true },
    ])
    const record = selected?.records.findLast(
      (item) => item.title === `context:frame:${projected.frameId}`
    )
    if (!record) throw new AppError('NOT_FOUND', '待核对的上下文帧尚未登记')
    const saved = JSON.parse((await this.storage.get(this.id, record.objectId))!)
    if (!saved.proof) return { body, prompt: memoryPrompt(body, previous) }
    const delivered = selected?.records.findLast((item) => item.title === 'context:delivered')
    const accepted = delivered
      ? JSON.parse((await this.storage.get(this.id, delivered.objectId))!).accepted
      : undefined
    const messages = new Set(history.filter((item) => item.role === 'user').map(memoryMessageKey))
    const compatible =
      accepted &&
      accepted.authorization === saved.proof.authorization &&
      accepted.segment.id === saved.segment.id &&
      accepted.segment.revision === saved.segment.revision
    const carriers: Array<{ message: string; proofs: readonly SegmentOutputProof[] }> = []
    const known = new Set<string>()
    for (const carrier of [
      ...saved.proof.history,
      ...(compatible ? accepted.carriers : []),
    ] as ReadonlyArray<{ message: string; proofs: readonly SegmentOutputProof[] }>) {
      if (!messages.has(carrier.message)) continue
      const identity = scriptOutputs.hash([carrier.message, carrier.proofs])
      if (known.has(identity)) continue
      known.add(identity)
      carriers.push(carrier)
    }
    const shown = new Set(memoryOutputRefs(body, previous))
    const current: SegmentOutputProof[] = []
    for (const item of projected.partitions.recent.results as ReadonlyArray<{
      ref: string
      text?: string
      outputFormat?: string
    }>) {
      if (!shown.has(item.ref) || !item.text) continue
      const source = saved.proof.current.find(
        (candidate: { ref: string; text: string }) =>
          candidate.ref === item.ref &&
          candidate.text === scriptOutputs.hash([item.ref, item.outputFormat, item.text])
      )
      if (source) current.push(...source.proofs)
    }
    const permitted = new Set(
      (
        await this.authorizedProofs(
          [...carriers.flatMap((carrier) => carrier.proofs), ...current],
          saved.proof.authorization,
          saved.segment,
          signal
        )
      ).map((proof) => JSON.stringify(proof))
    )
    const authorized = memoryProofCarriers(carriers)
      .map((carrier) => ({
        ...carrier,
        proofs: carrier.proofs.filter((proof) => permitted.has(JSON.stringify(proof))),
      }))
      .filter((carrier) => carrier.proofs.length)
    const currentProofs = current.filter((proof) => permitted.has(JSON.stringify(proof)))
    const complete = memoryDeliveredOutputs([
      ...authorized.flatMap((carrier) => carrier.proofs),
      ...currentProofs,
    ])
    const missing = saved.proof.missing.filter(
      (item: Partial<SegmentOutputProof> & { reason: string }) =>
        !['required-body-unavailable', 'required-lease-not-delivered'].includes(item.reason) ||
        !item.contentHash ||
        !complete.has(JSON.stringify([item.ref, item.key, item.contentHash]))
    )
    projected.partitions.runtime.decision.missing = missing.map(
      (item: { contentHash?: string }) => {
        const { contentHash: _contentHash, ...gap } = item
        return gap
      }
    )
    projected.memoryStatus.footprint.runtime = JSON.stringify(projected.partitions.runtime).length
    const resolved = JSON.stringify(projected)
    const prompt = memoryPrompt(resolved, previous)
    await this.context.append(
      {
        kind: 'audit',
        title: `context:request-proof:${projected.frameId}`,
        body: JSON.stringify({
          frameId: projected.frameId,
          authorization: saved.proof.authorization,
          segment: { id: saved.segment.id, revision: saved.segment.revision },
          bodyHash: scriptOutputs.hash(resolved),
          promptHash: scriptOutputs.hash(prompt),
          promptChars: prompt.length,
          carriers: authorized,
          current: currentProofs,
          missing: saved.proof.missing,
        }),
        sources: [record.ref],
      },
      signal
    )
    return { body: resolved, prompt }
  }

  public async acknowledge(
    frameId: string,
    signal: AbortSignal,
    request?: ModelTurnRequest
  ): Promise<Optional<ScriptDecisionBasis>> {
    const selected = this.storage.selectSnapshot
      ? await this.storage.selectSnapshot(this.id, [
          { title: `context:frame:${frameId}`, latest: true },
          { title: 'context:delivered', latest: true },
          { title: `context:request-proof:${frameId}`, latest: true },
        ])
      : undefined
    const snapshot = this.storage.selectSnapshot ? selected : await this.storage.load(this.id)
    signal.throwIfAborted()
    const frame = snapshot?.records.findLast(
      (record) => record.title === `context:frame:${frameId}`
    )
    if (!frame) throw new AppError('NOT_FOUND', '上下文帧尚未登记')
    const previous = snapshot?.records.findLast((record) => record.title === 'context:delivered')
    const duplicate = Boolean(
      previous &&
      JSON.parse((await this.storage.get(this.id, previous.objectId))!).frameId === frameId
    )
    if (duplicate && !request) return
    const body = (await this.storage.get(this.id, frame.objectId))!
    // 本帧第一次交付的段内历史从此冻结，同段后续帧逐字复用
    const delivered = JSON.parse(body).segment as Optional<{
      id: string
      revision: number
      fresh: ContextSegment['entries']
    }>
    if (!duplicate && delivered?.fresh.length) {
      const segment = await this.recent.segment(signal)
      if (segment?.id === delivered.id && segment.revision === delivered.revision) {
        const fresh = request
          ? (
              await Promise.all(
                delivered.fresh.map(async (entry) => ({
                  entry,
                  content: await this.storage.get(this.id, entry.objectId),
                }))
              )
            )
              .filter(({ entry, content }) =>
                (request.history ?? []).some(
                  (message) => message.role === entry.role && message.content === content
                )
              )
              .map(({ entry }) => entry)
          : delivered.fresh
        const known = new Set(segment.entries.map((entry) => entry.ref))
        await this.recent.commit(
          {
            ...segment,
            entries: [...segment.entries, ...fresh.filter((entry) => !known.has(entry.ref))],
          },
          signal
        )
      }
    }
    const proofRecord = snapshot?.records.findLast(
      (record) => record.title === `context:request-proof:${frameId}`
    )
    const candidate = proofRecord
      ? JSON.parse((await this.storage.get(this.id, proofRecord.objectId))!)
      : undefined
    let basis: Optional<ScriptDecisionBasis>
    let accepted
    if (request && candidate) {
      const material = request.materials.findLast((item) => item.origin === 'runtime-view')
      const exact =
        material &&
        scriptOutputs.hash(material.text) === candidate.bodyHash &&
        scriptOutputs.hash(request.compiledPrompt?.slice(0, candidate.promptChars)) ===
          candidate.promptHash
      const history = new Set(
        (request.history ?? []).filter((item) => item.role === 'user').map(memoryMessageKey)
      )
      const carriers: Array<{ message: string; proofs: readonly SegmentOutputProof[] }> = []
      if (exact) {
        for (const carrier of candidate.carriers as ReadonlyArray<{
          message: string
          proofs: readonly SegmentOutputProof[]
        }>) {
          if (!history.has(carrier.message)) continue
          carriers.push(carrier)
        }
        const message = modelRequestEncoder.messages(request).at(-1)
        if (!isEmpty(candidate.current) && message?.role === 'user')
          carriers.push({ message: memoryMessageKey(message), proofs: candidate.current })
      }
      const permitted = new Set(
        (
          await this.authorizedProofs(
            carriers.flatMap((carrier) => carrier.proofs),
            candidate.authorization,
            candidate.segment,
            signal
          )
        ).map((proof) => JSON.stringify(proof))
      )
      const authorized = memoryProofCarriers(carriers)
        .map((carrier) => ({
          ...carrier,
          proofs: carrier.proofs.filter((proof) => permitted.has(JSON.stringify(proof))),
        }))
        .filter((carrier) => carrier.proofs.length)
      const complete = memoryDeliveredOutputs(authorized.flatMap((carrier) => carrier.proofs))
      basis = {
        frameId,
        missing: candidate.missing
          .filter(
            (item: Partial<SegmentOutputProof> & { reason: string }) =>
              !['required-body-unavailable', 'required-lease-not-delivered'].includes(
                item.reason
              ) ||
              !item.contentHash ||
              !complete.has(JSON.stringify([item.ref, item.key, item.contentHash]))
          )
          .map((item: { contentHash?: string }) => {
            const { contentHash: _contentHash, ...gap } = item
            return gap
          }),
      }
      accepted = {
        authorization: candidate.authorization,
        segment: candidate.segment,
        carriers: authorized,
      }
    }
    const acceptedBody = accepted ? JSON.stringify({ ...JSON.parse(body), accepted }) : body
    if (!previous || (await this.storage.get(this.id, previous.objectId)) !== acceptedBody)
      await this.context.append(
        { kind: 'audit', title: 'context:delivered', body: acceptedBody, sources: [frame.ref] },
        signal
      )
    return basis
  }
}
