import { createHash } from 'node:crypto'

import type {
  ContextRecord,
  ContextRef,
  ContextRuntime,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import { createContextReference } from '@velaros-ai/context'
import { isArray, isEmpty, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ActiveContextLimits } from '../../system/contract/constants.js'
import type {
  ActiveContextEvidence,
  ActiveContextItem,
  ActiveContextPatch,
  ActiveContextState,
} from '../../system/types/maintenance.js'
import type { StoredActiveContext } from '../types/segment.js'
import { memoryReference } from '../utils/context-memory.js'

/** 当前认识的持久投影：原文与历史摘要不变，逐项取代、撤销和解决都有来源。 */
export interface ActiveContextApi {
  /** 增量导入输入摘要和未解事项，并返回尚待核对的原始用户输入。 */
  read(signal: AbortSignal): Promise<ActiveContextState>
  /** 在整理事务里发布带来源的逐项变更；visibleInputs 是全文实际进入该模型材料的输入。 */
  apply(
    patch: ActiveContextPatch,
    visibleInputs: readonly ContextRef[],
    signal: AbortSignal
  ): Promise<void>
}

/** 存储的当前项始终是模型解释；最新用户原文独立投递并具有更高权威。 */
export class ActiveContext implements ActiveContextApi {
  public constructor(
    private readonly id: string,
    private readonly context: ContextRuntime,
    private readonly storage: ContextStorage
  ) {}

  private async snapshot(
    previous: StoredActiveContext,
    latest?: ContextRef
  ): Promise<Nullable<ContextState>> {
    if (!this.storage.selectSnapshot) return this.storage.load(this.id)
    const selected = await this.storage.selectSnapshot(this.id, [
      { title: 'search:history-reset', latest: true },
      { title: 'context:active-state', latest: true },
      { title: 'user:intent', after: previous.through },
      { title: 'context:volume-narrative', after: previous.through },
      { kind: 'user', after: Math.max(previous.reset, previous.reviewedThrough) },
      ...(latest ? [{ refId: latest.id }] : []),
      { latest: true },
    ])
    return selected ? { ...selected.metadata, records: selected.records } : null
  }

  private async head(): Promise<Nullable<ContextState>> {
    if (!this.storage.selectSnapshot) return this.storage.load(this.id)
    const selected = await this.storage.selectSnapshot(this.id, [
      { title: 'search:history-reset', latest: true },
      { title: 'context:active-state', latest: true },
    ])
    return selected ? { ...selected.metadata, records: selected.records } : null
  }

  private async stored(state: ContextState): Promise<StoredActiveContext> {
    const reset = Math.max(
      state.task?.startedSequence ?? 0,
      state.records.findLast((record) => record.title === 'search:history-reset')?.sequence ?? 0
    )
    const record = state.records.findLast(
      (item) => item.title === 'context:active-state' && item.sequence > reset
    )
    return record
      ? JSON.parse((await this.storage.get(this.id, record.objectId))!)
      : {
          revision: 0,
          through: reset,
          reset,
          reviewedThrough: reset,
          items: [],
        }
  }

  private async save(
    state: ContextState,
    value: StoredActiveContext,
    transition?: unknown
  ): Promise<boolean> {
    const bodies = [
      ...(transition
        ? [{ title: 'context:active-transition', body: JSON.stringify(transition) }]
        : []),
      ...(
        (transition as { transitions?: ReadonlyArray<{ prior: ActiveContextItem }> } | undefined)
          ?.transitions ?? []
      ).map((item) => ({
        title: `context:active-retired:${item.prior.id}`,
        body: JSON.stringify(item),
      })),
      ...(
        (transition as { transitions?: ReadonlyArray<{ prior: ActiveContextItem }> } | undefined)
          ?.transitions ?? []
      )
        .filter((item) => item.prior.kind === 'constraint')
        .map((item) => ({
          title: `context:active-reviewed-input:${item.prior.sources[0]!.id}`,
          body: JSON.stringify(item.prior.sources[0]),
        })),
      { title: 'context:active-state', body: JSON.stringify(value) },
    ]
    const append: Array<Omit<ContextRecord, 'sequence'>> = []
    for (const item of bodies)
      append.push({
        ref: await createContextReference(this.storage, this.id),
        kind: 'audit',
        title: item.title,
        objectId: await this.storage.put(this.id, item.body),
        chars: item.body.length,
        sources: [],
        createdAt: new Date().toISOString(),
      })
    const { records: _records, ...metadata } = state
    if (this.storage.compareAndSwapMetadata)
      return this.storage.compareAndSwapMetadata(
        this.id,
        state.version,
        { ...metadata, version: state.version + 1 },
        append
      )
    const full = await this.storage.load(this.id)
    if (full?.version !== state.version) return false
    return this.storage.compareAndSwap(this.id, state.version, {
      ...full,
      version: state.version + 1,
      records: [
        ...full.records,
        ...append.map((item, index) => ({
          ...item,
          sequence: (full.records.at(-1)?.sequence ?? 0) + index + 1,
        })),
      ],
    })
  }

  private async current(signal: AbortSignal): Promise<{
    state: ContextState
    value: StoredActiveContext
    pendingSources: readonly ContextRef[]
  }> {
    for (let attempt = 0; attempt < 32; attempt++) {
      signal.throwIfAborted()
      const head = await this.head()
      if (!head) throw new AppError('UNAVAILABLE', '当前会话尚未建立')
      const previous = await this.stored(head)
      const state = await this.snapshot(previous, head.task?.goals.at(-1))
      if (!state || state.version !== head.version) continue
      const records = state.records.filter(
        (record) =>
          record.sequence > previous.through &&
          record.sequence > previous.reset &&
          ['user:intent', 'context:volume-narrative'].includes(record.title)
      )
      if (isEmpty(records)) return { state, value: previous, pendingSources: [] }
      let items = new Map(previous.items.map((item) => [item.id, item]))
      let through = previous.through
      for (const record of records) {
        const before = new Map(items)
        const body = JSON.parse((await this.storage.get(this.id, record.objectId))!)
        const kind =
          record.title === 'user:intent' ? ('constraint' as const) : ('question' as const)
        const original = kind === 'constraint' ? (body.original as ContextRef) : record.ref
        if (!original || original.sessionId !== this.id)
          throw new AppError('INVARIANT', '当前认识的来源身份缺失')
        if (kind === 'constraint' && !state.task?.goals.some((goal) => goal.id === original.id)) {
          through = record.sequence
          continue
        }
        if (kind === 'constraint') {
          const title = `context:active-reviewed-input:${original.id}`
          const reviewedSource = this.storage.selectSnapshot
            ? (
                await this.storage.selectSnapshot(this.id, [
                  { title, after: previous.reset, latest: true },
                ])
              )?.records.some((record) => record.title === title)
            : state.records.some((item) => item.title === title && item.sequence > previous.reset)
          if (reviewedSource) {
            through = record.sequence
            continue
          }
        }
        const texts: readonly string[] =
          kind === 'constraint' ? (body.constraints ?? []) : (body.unresolved ?? [])
        for (const text of texts) {
          if (!isString(text) || !text.trim()) continue
          const hash = createHash('sha256')
            .update(`${kind}:${kind === 'constraint' ? original.id : ''}:${text}`)
            .digest('hex')
          const id = `${kind}:${hash}`
          const retired = this.storage.selectSnapshot
            ? (
                await this.storage.selectSnapshot(this.id, [
                  { title: `context:active-retired:${id}`, after: previous.reset, latest: true },
                ])
              )?.records.some((item) => item.sequence > previous.reset)
            : state.records.some(
                (item) =>
                  item.sequence > previous.reset && item.title === `context:active-retired:${id}`
              )
          if (retired) continue
          if (!items.has(id))
            items.set(id, {
              id,
              kind,
              text,
              sources: kind === 'constraint' ? [original, record.ref] : [record.ref],
              origin: 'model-interpretation',
            })
        }
        if (items.size > ActiveContextLimits.items) {
          items = before
          break
        }
        through = record.sequence
      }
      if (through === previous.through)
        return { state, value: previous, pendingSources: records.map((record) => record.ref) }
      const value = {
        ...previous,
        revision: previous.revision + 1,
        through,
        items: [...items.values()],
      }
      if (await this.save(state, value)) continue
    }
    throw new AppError('CONFLICT', '当前认识更新持续冲突')
  }

  public async read(signal: AbortSignal): Promise<ActiveContextState> {
    const { state, value, pendingSources } = await this.current(signal)
    const sequence = new Map(state.records.map((record) => [record.ref.id, record.sequence]))
    const pendingInputs = (state.task?.goals ?? []).filter(
      (ref) => (sequence.get(ref.id) ?? 0) > Math.max(value.reset, value.reviewedThrough)
    )
    return {
      revision: value.revision,
      items: value.items,
      status: !isEmpty(pendingInputs) || !isEmpty(pendingSources) ? 'pending-review' : 'reviewed',
      pendingInputs,
      pendingSources,
    }
  }

  private async evidence(
    state: ContextState,
    kind: ActiveContextItem['kind'],
    evidenceItems: readonly ActiveContextEvidence[],
    visibleInputs: readonly ContextRef[],
    basis?: ContextRef
  ): Promise<readonly ContextRef[]> {
    if (
      !isArray(evidenceItems) ||
      isEmpty(evidenceItems) ||
      evidenceItems.length > ActiveContextLimits.evidence
    )
      throw new AppError('VALIDATION', '当前状态证据段数无效')
    const sources: ContextRef[] = []
    const original = basis ? await this.context.readInput(basis, { limit: 1 }) : undefined
    for (const evidence of evidenceItems) {
      if (
        !Number.isSafeInteger(evidence.offset) ||
        evidence.offset < 0 ||
        !isString(evidence.quote) ||
        !evidence.quote.trim() ||
        evidence.quote.length > ActiveContextLimits.quoteChars ||
        evidence.ref.sessionId !== this.id
      )
        throw new AppError('VALIDATION', '当前状态证据引文无效')
      const selected = this.storage.selectSnapshot
        ? await this.storage.selectSnapshot(this.id, [
            { refId: evidence.ref.id },
            { title: 'search:history-reset', latest: true },
          ])
        : undefined
      let authorization = selected
        ? { ...selected.metadata, records: selected.records }
        : await this.storage.load(this.id)
      const reset = Math.max(
        authorization?.task?.startedSequence ?? 0,
        authorization?.records.findLast((item) => item.title === 'search:history-reset')
          ?.sequence ?? 0
      )
      if (
        selected?.records.some((item) => item.ref.id === evidence.ref.id && item.sequence <= reset)
      ) {
        const attachments = await this.storage.selectSnapshot!(this.id, [
          { kind: 'user', after: reset },
        ])
        if (!attachments || attachments.metadata.version !== selected.metadata.version)
          throw new AppError('CONFLICT', '当前状态证据授权已变化')
        authorization = {
          ...selected.metadata,
          records: [...selected.records, ...attachments.records],
        }
      }
      const record = memoryReference(authorization, evidence.ref)
      if (!record) throw new AppError('PERMISSION', '当前状态证据不在活动授权范围')
      if (
        kind === 'question' &&
        record.kind !== 'user' &&
        !/^script:(?:[a-f0-9]{8}|[0-9a-f-]{36}):result$/u.test(record.title)
      )
        throw new AppError('PERMISSION', '未解事项只能依据用户原文或真实执行结果变更')
      if (
        kind === 'constraint' &&
        (record.kind !== 'user' ||
          (original && record.sequence <= original.record.sequence) ||
          !state.task?.goals.some((ref) => ref.id === record.ref.id) ||
          !visibleInputs.some((ref) => ref.id === record.ref.id && ref.sessionId === this.id))
      )
        throw new AppError(
          'PERMISSION',
          '约束需要全文已读的用户证据；取代或撤销还要求证据晚于原约束'
        )
      const page = await (record.kind === 'user'
        ? this.context.readInput(evidence.ref, {
            offset: evidence.offset,
            limit: evidence.quote.length,
          })
        : this.context.read(evidence.ref, {
            offset: evidence.offset,
            limit: evidence.quote.length,
          }))
      if (page.text !== evidence.quote) throw new AppError('CONFLICT', '当前状态证据引文与原文不符')
      sources.push(evidence.ref)
    }
    return sources
  }

  public async apply(
    patch: ActiveContextPatch,
    visibleInputs: readonly ContextRef[],
    signal: AbortSignal
  ): Promise<void> {
    if (
      !Number.isSafeInteger(patch.baseRevision) ||
      !isArray(patch.changes) ||
      patch.changes.length > ActiveContextLimits.changes ||
      (!isUndefined(patch.additions) && !isArray(patch.additions)) ||
      patch.changes.length + (patch.additions?.length ?? 0) > ActiveContextLimits.changes ||
      new Set(patch.changes.map((item) => item.id)).size !== patch.changes.length
    )
      throw new AppError('VALIDATION', '当前状态变更版本、条数或身份无效')
    const { state, value } = await this.current(signal)
    if (value.revision !== patch.baseRevision) throw new AppError('CONFLICT', '当前认识版本已变化')
    const latest = state.task?.goals.at(-1)
    if (
      !latest ||
      latest.id !== patch.reviewedInput?.id ||
      patch.reviewedInput.sessionId !== this.id ||
      !visibleInputs.some((ref) => ref.id === latest.id && ref.sessionId === this.id)
    )
      throw new AppError('CONTEXT_INPUT_UNSEEN', '核对当前状态前必须完整阅读最新用户原文')
    const reviewed = state.records.find((record) => record.ref.id === latest.id)!
    const items = new Map(value.items.map((item) => [item.id, item]))
    const transitions = []
    for (const change of patch.changes) {
      const prior = items.get(change.id)
      if (
        !prior ||
        !['superseded', 'retracted', 'resolved'].includes(change.status) ||
        (prior.kind === 'constraint' && change.status === 'resolved') ||
        (prior.kind === 'question' && change.status === 'retracted') ||
        !isArray(change.evidence) ||
        isEmpty(change.evidence) ||
        change.evidence.length > ActiveContextLimits.evidence ||
        (change.status === 'superseded'
          ? !isString(change.replacement) ||
            !change.replacement.trim() ||
            change.replacement.length > ActiveContextLimits.textChars
          : !isUndefined(change.replacement))
      )
        throw new AppError('VALIDATION', '当前状态逐项变更无效')
      const sources = await this.evidence(
        state,
        prior.kind,
        change.evidence,
        visibleInputs,
        prior.kind === 'constraint' ? prior.sources[0] : undefined
      )
      items.delete(prior.id)
      let replacement: ActiveContextItem | undefined
      if (change.status === 'superseded') {
        replacement = {
          id: `${prior.kind}:${(await createContextReference(this.storage, this.id)).id}`,
          kind: prior.kind,
          text: change.replacement!,
          sources,
          origin: 'model-interpretation',
        }
        items.set(replacement.id, replacement)
      }
      transitions.push({
        prior,
        status: change.status,
        replacement,
        evidence: change.evidence,
        origin: 'model-interpretation',
      })
    }
    const additions: ActiveContextItem[] = []
    for (const item of patch.additions ?? []) {
      if (
        !['constraint', 'question'].includes(item.kind) ||
        !isString(item.text) ||
        !item.text.trim() ||
        item.text.length > ActiveContextLimits.textChars
      )
        throw new AppError('VALIDATION', '新增当前项无效')
      const sources = await this.evidence(state, item.kind, item.evidence, visibleInputs)
      const added: ActiveContextItem = {
        id: `${item.kind}:${(await createContextReference(this.storage, this.id)).id}`,
        kind: item.kind,
        text: item.text,
        sources,
        origin: 'model-interpretation',
      }
      items.set(added.id, added)
      additions.push(added)
    }
    if (items.size > ActiveContextLimits.items)
      throw new AppError('LIMIT', '当前项容量已满；请先逐项关闭已有项')
    signal.throwIfAborted()
    if (
      !(await this.save(
        state,
        {
          ...value,
          revision: value.revision + 1,
          reviewedThrough: reviewed.sequence,
          items: [...items.values()],
        },
        { reviewedInput: latest, transitions, additions, additionEvidence: patch.additions ?? [] }
      ))
    )
      throw new AppError('CONFLICT', '当前认识发布版本冲突')
  }
}
