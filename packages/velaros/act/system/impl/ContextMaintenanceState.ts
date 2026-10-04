import { createHash } from 'node:crypto'

import type { ContextContent, ContextRef, ContextState, ContextStorage } from '@velaros-ai/context'
import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { isFalse, isUndefined, toNullable } from '@velaros-ai/core'
import { isArray, isBoolean, isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelImage } from '@velaros-ai/kernel'
import {
  type CodeProgramRequest,
  type ScriptOutputCapture,
  scriptOutputs,
  type ScriptOutputSummary,
} from '@velaros-ai/script'

import { ContextMaintenanceReadLimits, VelarosRunLimits } from '../../runtime/contract/constants.js'
import { ActiveContext } from '../../runtime/impl/ActiveContext.js'
import { ContextMemory } from '../../runtime/impl/ContextMemory.js'
import { ContextPatchStore } from '../../runtime/impl/ContextPatchStore.js'
import { ProgramContext } from '../../runtime/impl/ProgramContext.js'
import { RecentContext } from '../../runtime/impl/RecentContext.js'
import { memoryReference } from '../../runtime/utils/context-memory.js'
import { awaitModelPreparation } from '../../runtime/utils/model-budget.js'
import { ContextPatchLimits } from '../contract/constants.js'
import type { ContextCandidateValidator } from '../contract/requires.js'
import type {
  ContextMaintenancePage,
  ContextMaintenanceSnapshot,
  ContextPatch,
  ContextProjectionPolicy,
} from '../types/maintenance.js'

/** 父会话快照与结构化补丁的原子发布。 */
export interface ContextMaintenanceStateApi {
  /** 固定材料版本和保护集合；不复制全部原文到模型窗口。 */
  snapshot(targetChars: number, signal: AbortSignal): Promise<ContextMaintenanceSnapshot>
  /** 仅读取固定快照中已经授权的原文页。 */
  read(
    snapshot: ContextMaintenanceSnapshot,
    ref: ContextRef,
    offset: number,
    limit: number,
    signal: AbortSignal
  ): Promise<ContextContent>
  /** 列举固定快照中的材料元数据。 */
  list(
    snapshot: ContextMaintenanceSnapshot,
    after: number,
    limit: number,
    signal: AbortSignal
  ): Promise<ContextMaintenancePage>
  /** 将用户输入原文页直接放入整理模型的有界事实区。 */
  material(snapshot: ContextMaintenanceSnapshot, maxChars: number): unknown
  /** 只在模型响应被接纳后确认其请求中真实展示的输入范围。 */
  acknowledge(snapshot: ContextMaintenanceSnapshot, material: unknown): void
  /** 编译候选补丁并验证全部操作，保持父会话元数据不变。 */
  validate(
    snapshot: ContextMaintenanceSnapshot,
    patch: ContextPatch,
    signal: AbortSignal
  ): Promise<void>
  /** 复用原操作校验；整组元数据经过一次 CAS 才进入父会话，派生展示保留到下一份策略或任务切换。 */
  apply(
    snapshot: ContextMaintenanceSnapshot,
    patch: ContextPatch,
    signal: AbortSignal
  ): Promise<ContextRef>
}

/** 整理模型持有只读材料，所有修改均由此宿主边界提交。 */
export class ContextMaintenanceState implements ContextMaintenanceStateApi {
  private inputRevision = ''
  private readonly inputPages = new Map<string, ContextContent>()
  private readonly inputVisible = new Map<string, Array<{ start: number; end: number }>>()
  private readonly recentPages: ContextContent[] = []
  private cached?: { revision: string; state: ContextState; metadataSignature: string }
  public constructor(
    private readonly id: string,
    private readonly storage: ContextStorage,
    private readonly preview?: ContextCandidateValidator
  ) {}

  private async version(state: ContextState): Promise<string> {
    const record = state.records.findLast((item) => item.title === 'script:lease-state')
    const leases = record ? JSON.parse((await this.storage.get(this.id, record.objectId))!) : {}
    const ignored =
      /^(model-tool:|act:event$|act:state$|model-request$|model-response|context:frame:|context:delivered$|context:history-index$|context:history-body$|context:segment-body$|context-maintenance:|script:lease-state$)/u
    const material = {
      records: state.records.filter((item) => !ignored.test(item.title)).map((item) => item.ref.id),
      workingSet: state.workingSet,
      inputSummaries: state.inputSummaries,
      task: state.task
        ? {
            storeRefs: state.task.storeRefs,
            releasedStoreRefs: state.task.releasedStoreRefs,
            revision: state.task.revision,
            goals: state.task.goals,
            capsule: state.task.capsule,
            mandatory: state.task.mandatory,
            activeExecutions: state.task.activeExecutions,
          }
        : null,
      programs: {
        observation: leases.observation,
        completedTurns: leases.completedTurns,
        leases: leases.leases,
        jobs: leases.jobs,
      },
    }
    return createHash('sha256').update(JSON.stringify(material)).digest('hex')
  }

  private async current(
    snapshot: ContextMaintenanceSnapshot,
    signal: AbortSignal,
    full = false
  ): Promise<ContextState> {
    signal.throwIfAborted()
    if (!full && this.cached?.revision === snapshot.baseRevision && this.storage.selectSnapshot) {
      const selected = await this.storage.selectSnapshot(this.id, [
        { after: snapshot.through },
        { title: 'script:lease-state', latest: true },
      ])
      const changes =
        selected?.records.filter(
          (record) =>
            record.sequence > snapshot.through &&
            !/^(model-tool:|act:event$|act:state$|model-request$|model-response|context:frame:|context:delivered$|context:history-index$|context:history-body$|context:segment-body$|context-maintenance:|script:lease-state$)/u.test(
              record.title
            )
        ) ?? []
      const metadataSignature = selected
        ? await this.version({
            ...selected.metadata,
            records: selected.records.filter((record) => record.title === 'script:lease-state'),
          })
        : ''
      if (!selected || changes.length || metadataSignature !== this.cached.metadataSignature)
        throw new AppError('CONTEXT_CONFLICT', '整理期间任务材料已变化，补丁尚未发布')
      return { ...selected.metadata, records: this.cached.state.records }
    }
    const state = await this.storage.load(this.id)
    if (!state || (await this.version(state)) !== snapshot.baseRevision)
      throw new AppError('CONTEXT_CONFLICT', '整理期间任务材料已变化，补丁尚未发布')
    return state
  }

  public async snapshot(
    targetChars: number,
    signal: AbortSignal
  ): Promise<ContextMaintenanceSnapshot> {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(targetChars) || targetChars < 512)
      throw new AppError('VALIDATION', '整理目标预算无效')
    const context = createContextRuntime({ sessionId: this.id, storage: this.storage })
    const active = await new ActiveContext(this.id, context, this.storage).read(signal)
    const state = await this.storage.load(this.id)
    if (!state?.task) throw new AppError('UNAVAILABLE', '整理需要已有任务')
    const programs = await new ProgramContext(this.id, context, this.storage).state()
    const protectedRefs = [
      ...(await context.inspect()).protected,
      ...state.records
        .filter((item) =>
          state.task!.mandatory.some(
            (feedback) =>
              (feedback.effect === 'unknown' || feedback.outcome === 'unknown') &&
              item.title === `script:${feedback.executionId}:result`
          )
        )
        .map((item) => item.ref),
    ]
    const reset = Math.max(
      state.records.findLast((record) => record.title === 'search:history-reset')?.sequence ?? 0,
      state?.task?.startedSequence ?? 0
    )
    let observation: ContextMaintenanceSnapshot['observation']
    if (programs.observation) {
      const source = await context.read(
        { sessionId: this.id, id: programs.observation },
        { limit: 1 }
      )
      const program = JSON.parse(
        (await this.storage.get(this.id, source.record.objectId))!
      ) as CodeProgramRequest
      let resultRef: Nullable<string> = null
      let capture: Optional<ScriptOutputCapture>
      for (const record of [...state.records].reverse())
        if (
          record.sequence > reset &&
          /^script:(?:[a-f0-9]{8}|[0-9a-f-]{36}):result$/u.test(record.title)
        ) {
          const value = JSON.parse((await this.storage.get(this.id, record.objectId))!)
          if (value.mode === 'observe') {
            resultRef = record.ref.id
            capture = value.output
            break
          }
        }
      observation = {
        resultRef,
        manifest: scriptOutputs.describe(program),
        blocks: (capture?.blocks ?? []).map((block) => ({
          key: block.key,
          contentHash: scriptOutputs.hash(block.value),
          chars: block.chars,
        })),
      }
    }
    const recent = new RecentContext(this.id, context, this.storage)
    const latest = (await recent.volumes(signal)).at(-1)
    const ledgers = await recent.ledgers(signal)
    const baseRevision = await this.version(state)
    this.cached = {
      revision: baseRevision,
      state,
      metadataSignature: await this.version({
        ...state,
        records: state.records.filter((record) => record.title === 'script:lease-state').slice(-1),
      }),
    }
    if (this.inputRevision !== baseRevision) {
      this.inputRevision = baseRevision
      this.inputPages.clear()
      this.inputVisible.clear()
      this.recentPages.length = 0
      for (const ref of state.task.goals) {
        const page = await context.readInput(ref, {
          limit: ContextMaintenanceReadLimits.maxPageChars,
        })
        this.inputPages.set(`${ref.id}:0`, page)
      }
      const records = state.records
        .filter(
          (record) =>
            record.sequence > Math.max(reset, latest?.volume.from ?? 0) &&
            (record.kind === 'assistant' ||
              /^script:(?:[a-f0-9]{8}|[0-9a-f-]{36}):result$/u.test(record.title) ||
              record.title.startsWith('workspace:note:')) &&
            Boolean(memoryReference(state, record.ref))
        )
        .slice(-ContextMaintenanceReadLimits.pageItems)
      const limit = Math.max(
        1,
        Math.floor(ContextMaintenanceReadLimits.maxPageChars / Math.max(1, records.length))
      )
      for (const record of records) {
        signal.throwIfAborted()
        this.recentPages.push(await context.read(record.ref, { limit }))
      }
    }
    return {
      active,
      storeRefs: state.task.storeRefs ?? [],
      taskRevision: scriptOutputs.hash([state.task.goals, reset]),
      volume: latest
        ? {
            ref: latest.ref,
            from: latest.volume.from,
            through: latest.volume.through,
            skeleton: latest.volume.skeleton,
          }
        : undefined,
      // 最新叙事里的未解事项原样给出，写新叙事时照抄还没解决的；否定尝试只供参照，按卷累积
      ledgers: {
        negativeAttempts: ledgers.negativeAttempts.items,
        unresolved: active.items
          .filter((item) => item.kind === 'question')
          .map((item) => item.text),
      },
      observation,
      baseRevision,
      targetChars,
      through: state.records.at(-1)?.sequence ?? 0,
      totalRecords: state.records.length,
      goals: state.task.goals,
      capsule: state.task.capsule,
      observationRef: toNullable(programs.observation),
      protectedRefs,
      inputRevisions: state.task.goals.map((ref) => {
        const prior = state.inputSummaries?.find((item) => item.input.id === ref.id)
        return { ref, revision: prior?.revision ?? 0, summaryRef: prior?.summary }
      }),
    }
  }

  public material(snapshot: ContextMaintenanceSnapshot, maxChars: number): unknown {
    const inputs: Array<{
      ref: ContextRef
      offset: number
      totalChars: number
      text: string
      nextOffset: Nullable<number>
    }> = []
    const recent: Array<{
      ref: ContextRef
      sequence: number
      kind: ContextContent['record']['kind']
      title: string
      offset: number
      totalChars: number
      text: string
      nextOffset: Nullable<number>
    }> = []
    const result = {
      kind: 'context-maintenance',
      baseRevision: snapshot.baseRevision,
      inputs,
      recent,
    }
    if (JSON.stringify(result).length > maxChars) return undefined
    if (snapshot.baseRevision !== this.inputRevision) return result
    const inputBudget = isEmpty(this.recentPages) ? maxChars : Math.floor(maxChars / 2)
    const pages = [...this.inputPages.values()].reverse().map((page) => {
      let start = page.offset
      let end = page.offset + page.text.length
      for (const range of this.inputVisible.get(page.record.ref.id) ?? []) {
        if (range.start <= start) start = Math.max(start, range.end)
        else {
          end = Math.min(end, range.start)
          break
        }
      }
      return { page, start, end }
    })
    const unread = pages.filter(({ start, end }) => start < end)
    const selected = isEmpty(unread)
      ? pages.map(({ page }) => ({ page, start: page.offset, end: page.offset + page.text.length }))
      : unread
    for (const { page, start, end } of selected) {
      const text = page.text.slice(start - page.offset, end - page.offset)
      const item = {
        ref: page.record.ref,
        offset: start,
        totalChars: page.totalChars,
        text,
        nextOffset: start + text.length < page.totalChars ? start + text.length : null,
      }
      let lower = 0
      let upper = text.length
      while (lower < upper) {
        const length = Math.ceil((lower + upper) / 2)
        const candidate = {
          ...item,
          text: text.slice(0, length),
          nextOffset: start + length < page.totalChars ? start + length : null,
        }
        if (JSON.stringify({ ...result, inputs: [...inputs, candidate] }).length <= inputBudget)
          lower = length
        else upper = length - 1
      }
      item.text = text.slice(0, lower)
      item.nextOffset = start + lower < page.totalChars ? start + lower : null
      if (
        (!item.text && page.totalChars) ||
        JSON.stringify({ ...result, inputs: [...inputs, item] }).length > inputBudget
      )
        continue
      inputs.push(item)
    }
    const history = [...this.recentPages].reverse()
    for (let index = 0; index < history.length; index++) {
      const page = history[index]!
      const budget = Math.floor(
        (maxChars - JSON.stringify(result).length) / (history.length - index)
      )
      const item = {
        ref: page.record.ref,
        sequence: page.record.sequence,
        kind: page.record.kind,
        title: page.record.title,
        offset: page.offset,
        totalChars: page.totalChars,
        text: page.text,
        nextOffset:
          page.offset + page.text.length < page.totalChars ? page.offset + page.text.length : null,
      }
      while (item.text && JSON.stringify(item).length + 1 > budget) {
        item.text = item.text.slice(0, Math.floor(item.text.length / 2))
        item.nextOffset =
          item.offset + item.text.length < item.totalChars ? item.offset + item.text.length : null
      }
      if (JSON.stringify({ ...result, recent: [...recent, item] }).length > maxChars) continue
      recent.push(item)
    }
    recent.reverse()
    return result
  }

  public acknowledge(snapshot: ContextMaintenanceSnapshot, material: unknown): void {
    const value = material as Optional<{
      baseRevision: string
      inputs: Array<{ ref: ContextRef; offset: number; totalChars: number; text: string }>
    }>
    if (
      !value ||
      value.baseRevision !== snapshot.baseRevision ||
      snapshot.baseRevision !== this.inputRevision
    )
      return
    for (const input of value.inputs) {
      const page = [...this.inputPages.values()].find(
        (page) =>
          page.record.ref.id === input.ref.id &&
          input.offset >= page.offset &&
          input.offset + input.text.length <= page.offset + page.text.length &&
          page.text.slice(
            input.offset - page.offset,
            input.offset - page.offset + input.text.length
          ) === input.text
      )
      if (!page || input.ref.sessionId !== this.id || input.totalChars !== page.totalChars) continue
      const ranges = this.inputVisible.get(input.ref.id) ?? []
      const range = { start: input.offset, end: input.offset + input.text.length }
      if (!ranges.some((prior) => prior.start <= range.start && prior.end >= range.end)) {
        const merged = [...ranges, range]
          .sort((a, b) => a.start - b.start)
          .reduce<Array<{ start: number; end: number }>>((all, current) => {
            const previous = all.at(-1)
            if (previous && previous.end >= current.start)
              previous.end = Math.max(previous.end, current.end)
            else all.push({ ...current })
            return all
          }, [])
        this.inputVisible.set(input.ref.id, merged)
      }
    }
  }

  public async list(
    snapshot: ContextMaintenanceSnapshot,
    after: number,
    limit: number,
    signal: AbortSignal
  ): Promise<ContextMaintenancePage> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ContextMaintenanceReadLimits.maxPageItems
    )
      throw new AppError(
        'VALIDATION',
        `整理目录每页 1–${ContextMaintenanceReadLimits.maxPageItems} 项`
      )
    const state = await this.current(snapshot, signal)
    const reset = Math.max(
      state.task?.startedSequence ?? 0,
      state.records.findLast((record) => record.title === 'search:history-reset')?.sequence ?? 0
    )
    const selected = this.storage.selectSnapshot
      ? await this.storage.selectSnapshot(this.id, [
          { after: Math.max(after, reset), through: snapshot.through, first: limit + 1 },
        ])
      : undefined
    const candidates = selected
      ? selected.records
      : state.records.filter(
          (record) => record.sequence > after && record.sequence <= snapshot.through
        )
    const scanned = candidates.slice(0, limit)
    const records = scanned.filter(
      (record) =>
        record.sequence > after &&
        record.sequence <= snapshot.through &&
        Boolean(memoryReference(state, record.ref)) &&
        !/^(model-tool:|act:event$|act:state$|model-request$|model-response|context:frame:|context:delivered$|context-maintenance:)/u.test(
          record.title
        )
    )
    return {
      items: records,
      nextAfter: candidates.length > limit ? scanned.at(-1)!.sequence : null,
    }
  }

  public async read(
    snapshot: ContextMaintenanceSnapshot,
    ref: ContextRef,
    offset: number,
    limit: number,
    signal: AbortSignal
  ): Promise<ContextContent> {
    const state = await this.current(snapshot, signal)
    const candidate = memoryReference(state, ref)
    const record = candidate && candidate.sequence <= snapshot.through ? candidate : undefined
    if (ref.sessionId !== this.id || !record)
      throw new AppError('SCOPE_MISMATCH', '引用不在整理快照授权范围')
    const context = createContextRuntime({ sessionId: this.id, storage: this.storage })
    const page = await (record.kind === 'user'
      ? context.readInput(ref, { offset, limit })
      : context.read(ref, { offset, limit }))
    if (record.kind === 'user') this.inputPages.set(`${ref.id}:${page.offset}`, page)
    return page
  }

  public async validate(
    snapshot: ContextMaintenanceSnapshot,
    patch: ContextPatch,
    signal: AbortSignal
  ): Promise<void> {
    await this.prepare(snapshot, patch, signal, false)
  }

  public async apply(
    snapshot: ContextMaintenanceSnapshot,
    patch: ContextPatch,
    signal: AbortSignal
  ): Promise<ContextRef> {
    return this.prepare(snapshot, patch, signal, true)
  }

  private async prepare(
    snapshot: ContextMaintenanceSnapshot,
    patch: ContextPatch,
    signal: AbortSignal,
    publish: boolean
  ): Promise<ContextRef> {
    if (
      !patch ||
      Object.keys(patch).some(
        (key) =>
          ![
            'baseRevision',
            'summary',
            'unresolved',
            'active',
            'notes',
            'inputs',
            'volume',
            'releaseResults',
            'releaseStoreRefs',
            'observation',
          ].includes(key)
      ) ||
      patch.baseRevision !== snapshot.baseRevision ||
      !isString(patch.summary) ||
      !patch.summary.trim() ||
      patch.summary.length > ContextPatchLimits.summaryChars ||
      !isArray(patch.unresolved) ||
      patch.unresolved.length > ContextPatchLimits.unresolved ||
      patch.unresolved.some(
        (item) => !isString(item) || item.length > ContextPatchLimits.unresolvedChars
      ) ||
      JSON.stringify(patch).length > ContextPatchLimits.patchChars
    )
      throw new AppError('VALIDATION', '上下文补丁格式、版本或大小无效')
    if (
      [patch.notes, patch.inputs, patch.releaseResults, patch.releaseStoreRefs].some(
        (items) =>
          !isUndefined(items) && (!isArray(items) || items.length > ContextPatchLimits.items)
      )
    )
      throw new AppError('LIMIT', '上下文补丁条目过多')
    if (patch.volume && !snapshot.volume)
      throw new AppError('VALIDATION', '快照里还没有卷，不能写卷叙事')
    if (
      patch.observation &&
      (patch.observation.sourceRef !== snapshot.observationRef ||
        Object.keys(patch.observation).some(
          (key) => !['sourceRef', 'config', 'outputs', 'summaries'].includes(key)
        ))
    )
      throw new AppError('VALIDATION', '观察展示补丁版本或字段无效')
    if (
      patch.observation?.summaries &&
      (!isArray(patch.observation.summaries) ||
        patch.observation.summaries.length > ContextPatchLimits.items)
    )
      throw new AppError('VALIDATION', '观察摘要数量无效')
    for (const summary of patch.observation?.summaries ?? []) {
      if (
        !summary ||
        !isString(summary.text) ||
        !summary.text.trim() ||
        summary.text.length > ContextPatchLimits.textChars ||
        summary.resultRef !== snapshot.observation?.resultRef ||
        !snapshot.observation.blocks.some(
          (block) => block.key === summary.key && block.contentHash === summary.contentHash
        )
      )
        throw new AppError('CONFLICT', '摘要与当前观察原文不匹配')
    }
    if (patch.releaseResults?.some((ref) => snapshot.protectedRefs.some((item) => item.id === ref)))
      throw new AppError('CONFLICT', '不能释放未决操作的上下文')
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.current(snapshot, signal, true)
      const staged = new ContextPatchStore(this.id, this.storage, state)
      const context = createContextRuntime({ sessionId: this.id, storage: staged })
      const programs = new ProgramContext(this.id, context, staged)
      const recent = new RecentContext(this.id, context, staged)
      const view = createContextView({ sessionId: this.id, storage: staged, context, sources: [] })
      const memory = new ContextMemory(this.id, context, staged, view, programs, recent)
      try {
        if (patch.active) {
          const visible: ContextRef[] = []
          for (const ref of snapshot.goals) {
            const original = await context.readInput(ref, { limit: 1 })
            if (
              this.inputVisible
                .get(ref.id)
                ?.some((range) => range.start === 0 && range.end >= original.totalChars)
            )
              visible.push(ref)
          }
          await new ActiveContext(this.id, context, staged).apply(patch.active, visible, signal)
        }
        const previousRecord = state.records.findLast(
          (record) =>
            record.title === 'context:projection-policy' &&
            record.sequence > (state.task?.startedSequence ?? 0)
        )
        const previousPolicy: Optional<ContextProjectionPolicy> = previousRecord
          ? JSON.parse((await staged.get(this.id, previousRecord.objectId))!)
          : undefined
        for (const note of patch.notes ?? []) {
          if (
            !note ||
            Object.keys(note).some((key) => !['ref', 'summary', 'resident'].includes(key)) ||
            !note.ref ||
            note.ref.sessionId !== this.id ||
            (!isUndefined(note.summary) &&
              (!isString(note.summary) ||
                !note.summary.trim() ||
                note.summary.length > ContextPatchLimits.textChars)) ||
            (!isUndefined(note.resident) && !isBoolean(note.resident)) ||
            (isUndefined(note.summary) && isUndefined(note.resident))
          )
            throw new AppError('VALIDATION', '笔记呈现补丁无效')
          const record = state.records.find(
            (item) =>
              item.ref.id === note.ref.id &&
              item.sequence > (state.task?.startedSequence ?? 0) &&
              item.title.startsWith('workspace:note:')
          )
          if (
            !record ||
            state.records.findLast((item) => item.title === record.title)?.ref.id !== note.ref.id
          )
            throw new AppError('WORKSPACE_CONFLICT', '笔记呈现引用不是当前原文版本')
          if (
            isFalse(note.resident) &&
            snapshot.protectedRefs.some((ref) => ref.id === note.ref.id)
          )
            throw new AppError('VALIDATION', '不能移出明确保留的笔记')
        }
        const noteViews = [
          ...(previousPolicy?.notes ?? []).filter(
            (old) => !patch.notes?.some((note) => note.ref.id === old.ref.id)
          ),
          ...(patch.notes ?? []),
        ]
          .filter((note) =>
            state.records.some(
              (record) =>
                record.ref.id === note.ref.id &&
                state.records.findLast((item) => item.title === record.title)?.ref.id ===
                  note.ref.id
            )
          )
          .slice(-ContextPatchLimits.items)
        for (const input of patch.inputs ?? []) {
          const original = await context.readInput(input.ref, { limit: 1 })
          const visible = this.inputVisible.get(input.ref.id)
          if (
            this.inputRevision !== snapshot.baseRevision ||
            !visible?.some((range) => range.start === 0 && range.end >= original.totalChars)
          )
            throw new AppError(
              'CONTEXT_INPUT_UNSEEN',
              '输入原文尚未完整进入整理模型上下文；请分页读取并在下一轮查看 runtime.modelTool.inputs，或省略该 inputs 修改'
            )
          const prior = state.inputSummaries?.find(
            (entry) =>
              entry.input.id === input.ref.id && entry.input.sessionId === input.ref.sessionId
          )
          if (prior) {
            const record = await context.read(prior.summary, { limit: 1 })
            const previous = JSON.parse((await staged.get(this.id, record.record.objectId))!)
            if (
              previous.constraints.some(
                (constraint: string) => !input.constraints.includes(constraint)
              )
            )
              throw new AppError(
                'CONTEXT_CONSTRAINT',
                `整理不能移除已确认的用户约束；用 context-materials.read 读取 ${JSON.stringify(prior.summary)}，逐字保留其中 constraints 后补充新约束，或省略该 inputs 修改`
              )
          }
          await context.summarizeInput(input, signal)
        }
        if (patch.releaseStoreRefs?.length) {
          if (
            patch.releaseStoreRefs.some((id) => !isString(id) || !snapshot.storeRefs?.includes(id))
          )
            throw new AppError('VALIDATION', '只能释放快照中的当前任务空间引用')
          const current = (await staged.load(this.id))!
          await staged.compareAndSwap(this.id, current.version, {
            ...current,
            version: current.version + 1,
            task: {
              ...current.task!,
              storeRefs: current.task!.storeRefs?.filter(
                (id) => !patch.releaseStoreRefs!.includes(id)
              ),
              releasedStoreRefs: [
                ...new Set([...(current.task!.releasedStoreRefs ?? []), ...patch.releaseStoreRefs]),
              ],
            },
          })
        }
        if (patch.volume) await recent.narrate(snapshot.volume!.ref, patch.volume, signal)
        for (const ref of patch.releaseResults ?? []) await programs.release(ref, signal)
        let observationSourceRef = snapshot.observationRef
        if (patch.observation) {
          const { sourceRef, config, outputs, summaries } = patch.observation
          if (config || outputs?.length)
            observationSourceRef = await programs.editObservation(
              sourceRef,
              { config, outputs },
              patch.summary,
              signal
            )
          if (summaries?.length) {
            const oldRecord = state.records.findLast(
              (record) => record.title === 'script:output-summaries'
            )
            const prior: ScriptOutputSummary[] = oldRecord
              ? JSON.parse((await this.storage.get(this.id, oldRecord.objectId))!)
              : []
            const merged = [
              ...prior.filter((old) => !summaries.some((item) => item.key === old.key)),
              ...summaries.map(({ resultRef: _resultRef, ...item }) => ({
                ...item,
                taskRevision: snapshot.taskRevision,
              })),
            ].slice(-ContextPatchLimits.items)
            await context.append(
              {
                kind: 'audit',
                title: 'script:output-summaries',
                body: JSON.stringify(merged),
                sources: summaries.map((item) => ({ sessionId: this.id, id: item.resultRef })),
              },
              signal
            )
          }
        }
        const report = await context.append(
          {
            kind: 'audit',
            title: 'context-maintenance:applied',
            body: JSON.stringify({
              summary: patch.summary,
              unresolved: patch.unresolved,
              baseRevision: patch.baseRevision,
              changes: {
                releasedStoreRefs: patch.releaseStoreRefs ?? [],
                notes:
                  patch.notes?.map((note) => ({
                    ref: note.ref,
                    representation: isFalse(note.resident)
                      ? 'reference'
                      : note.summary
                        ? 'summary'
                        : 'full',
                  })) ?? [],
                inputs: patch.inputs?.map((input) => input.ref) ?? [],
                volume: patch.volume ? snapshot.volume!.ref : null,
                released: patch.releaseResults ?? [],
                observation: patch.observation
                  ? {
                      ...patch.observation,
                      publishedSourceRef: observationSourceRef,
                      executed: false,
                    }
                  : null,
              },
              targetChars: snapshot.targetChars,
            }),
          },
          signal
        )
        const policy: ContextProjectionPolicy = {
          notes: noteViews,
          origin: 'model-interpretation',
          maxChars: snapshot.targetChars,
          summary: patch.summary,
          unresolved: patch.unresolved,
          report: report.ref,
        }
        await context.append(
          {
            kind: 'audit',
            title: 'context:projection-policy',
            body: JSON.stringify(policy),
            sources: [report.ref],
          },
          signal
        )
        // 真实组装候选五区，只重投影归档结果，不运行 observe 或 execute。
        const currentView =
          state.task?.view ?? (await view.preview({ maxChars: snapshot.targetChars }, signal))
        const goals = await Promise.all(
          snapshot.goals.map((ref) =>
            context.projectInput(
              ref,
              Math.max(1, Math.floor(snapshot.targetChars / Math.max(4, snapshot.goals.length * 4)))
            )
          )
        )
        const observationRef = snapshot.observation?.resultRef
          ? { sessionId: this.id, id: snapshot.observation.resultRef }
          : undefined
        const images: ModelImage[] = []
        if (observationRef) {
          const record = await context.read(observationRef, { limit: 1 })
          const output = JSON.parse((await staged.get(this.id, record.record.objectId))!)
          for (const ref of output.attachments ?? []) {
            const attachment = await context.read(ref, { limit: 1 })
            images.push(JSON.parse((await staged.get(this.id, attachment.record.objectId))!))
          }
        }
        for (const ref of snapshot.intent?.preserve ?? [])
          if (ref.sessionId !== this.id || !memoryReference(state, ref))
            throw new AppError('PERMISSION', '明确保留材料已不在当前授权范围')
        let maxChars = snapshot.targetChars
        for (;;) {
          const candidate = await memory.project(
            { ...currentView, goals },
            observationRef,
            images,
            signal,
            maxChars
          )
          const frame = JSON.parse(candidate.body)
          if (!isEmpty(frame.partitions.runtime.decision.missing))
            throw new AppError('CONTEXT_REQUIRED', '整理候选缺失必需观察正文，补丁未发布')
          // 段起点之前提出的目标折叠在段底座里，其余的必须出现在本帧尾。
          const task = frame.partitions.task as {
            goals: ReadonlyArray<{ record: { ref: ContextRef } }>
            folded: { through: number }
          }
          if (
            goals.some(
              (goal) =>
                goal.record.sequence > task.folded.through &&
                !task.goals.some((item) => item.record.ref.id === goal.record.ref.id)
            )
          )
            throw new AppError('NOT_FOUND', '整理候选丢失任务目标')
          try {
            if (this.preview)
              await awaitModelPreparation(this.preview.validateCandidate(candidate, signal), signal)
            break
          } catch (error) {
            const recoveryChars = this.preview?.recoveryChars ?? VelarosRunLimits.recoveryChars
            if (
              (error as { code?: string })?.code !== 'CONTEXT_BUDGET' ||
              !Number.isSafeInteger(recoveryChars) ||
              recoveryChars < 1 ||
              recoveryChars >= maxChars
            )
              throw error
            // 与父循环同样收紧可选原文；不调用模型、不重跑观察、不释放结果。
            // 收紧后的候选仍须满足原文证明和实际父模型容量，失败则整组不发布。
            maxChars = recoveryChars
          }
        }
        if (!publish) {
          await this.current(snapshot, signal)
          return report.ref
        }
        if (await staged.commit(signal)) return report.ref
      } finally {
        await staged.close()
      }
    }
    throw new AppError('CONTEXT_CONFLICT', '上下文补丁发布持续冲突')
  }
}
