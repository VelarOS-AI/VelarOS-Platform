import type {
  ContextContent,
  ContextRecord,
  ContextRecordSelection,
  ContextRecordSnapshot,
  ContextRef,
  ContextRuntime,
  ContextStorage,
  ModelView,
} from '@velaros-ai/context'
import { createContextReference } from '@velaros-ai/context'
import { ContextLimits } from '@velaros-ai/context'
import {
  isArray,
  isFalse,
  isNull,
  isNumber,
  isPlainObject,
  isString,
  isUndefined,
  Log,
  toNullable,
} from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelImage, ModuleBinding } from '@velaros-ai/kernel'
import {
  type CodeProgramRequest,
  type ScriptOutputCapture,
  type ScriptOutputDisplay,
  type ScriptOutputEdit,
  type ScriptOutputFormat,
  type ScriptOutputProjection,
  scriptOutputs,
  type ScriptOutputSummary,
} from '@velaros-ai/script'

import { ScriptLeaseLimits } from '../../system/contract/constants.js'
import type { ProgramCatalogPort } from '../../system/contract/requires.js'
import type { ResultReleased, ResultRetained } from '../../system/types/memory.js'
import type {
  ProgramDescribeInput,
  ProgramDescriptor,
  ProgramPage,
  ProgramPublishInput,
  ProgramQuery,
} from '../../system/types/programs.js'
import type { ProgramCatalogValidator } from '../contract/requires.js'
import type { MemoryReadDelivery } from '../types/memory.js'
import type { PreparedScript } from '../types/program.js'
import type { ScriptRetention } from '../types/results.js'
import type {
  ObservationCollection,
  ProgramLeaseState,
  ScriptControlIdentity,
  ScriptJob,
  ScriptProgramVersion,
} from '../types/runtime.js'
import type {
  SegmentEntry,
  SegmentOutputCoverage,
  SegmentOutputProof,
  SegmentOutputView,
} from '../types/segment.js'
import type { ScriptSubmissionReceipt } from '../types/session.js'
import { executionMaterial, projectMaterial } from '../utils/materials.js'
import { catalogPublication, catalogQuery } from '../utils/program-catalog.js'
import {
  allocateProgramResultBudgets,
  programContentChange,
  programContentText,
  programCoveredOutputs,
  programFailure,
  programOutputViews,
} from '../utils/program-context.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

/** 与 ContextStorage 共用记录的脚本上下文及可见租约。 */
export interface ProgramContextApi {
  /** 当前会话源码归档上的持久程序目录；发布仍重新检查当前授权。 */
  readonly catalog: ProgramCatalogPort
  /** 保存实际采集或复用决定；仅消耗本次准备时看到的刷新身份。 */
  observationCollection(collection: ObservationCollection, refresh?: string): Promise<void>
  /** 更新真实观察健康状态；未知效果立即暂停，源码实质修改才能恢复。 */
  observeHealth(
    sourceRef: string,
    resultRef: string,
    success: boolean,
    uncertain: boolean
  ): Promise<void>
  /** 读取已保存的观察代码引用与租约计数。 */
  state(): Promise<ProgramLeaseState>
  /** 当前源码的不可变谱系，旧版源码可以没有谱系记录。 */
  version(ref: string): Promise<Optional<ScriptProgramVersion>>
  /** 获取已发布的提交回执；同一身份不同输入拒绝。 */
  receipt(control: ScriptControlIdentity): Promise<Optional<ScriptSubmissionReceipt>>
  /** 原子发布本次全部源码、观察版本和执行占位，返回是否由本调用占位。 */
  publish(
    prepared: readonly PreparedScript[],
    control: ScriptControlIdentity,
    receipt: ScriptSubmissionReceipt,
    activate: boolean,
    visible: boolean,
    signal: AbortSignal
  ): Promise<{ receipt: ScriptSubmissionReceipt; claimed: boolean }>
  /** 原子发布仅改变展示规则的观察源码版本，不运行采集。 */
  editObservation(
    sourceRef: string,
    edit: ScriptOutputEdit,
    reason: string,
    signal: AbortSignal
  ): Promise<string>
  /** 将已占位的一次执行记录为完成；回执丢失时占位仍禁止自动重跑。 */
  finish(
    control: ScriptControlIdentity,
    receipt: ScriptSubmissionReceipt
  ): Promise<ScriptSubmissionReceipt>
  /** 追加一次执行结果的可见租约。 */
  add(
    ref: ContextRef,
    source: ContextRef,
    executionId: string,
    turns: ScriptRetention
  ): Promise<void>
  /** 保存已受理的任务状态，真实结果仍由同一 journal 和结果记录提供。 */
  job(job: ScriptJob): Promise<void>
  /** 按当前会话读取不可变的完整脚本底稿。 */
  readProgram(ref: string, offset?: number, limit?: number): Promise<ContextContent>
  /** 明确读取原始结果，读取本身不延长自动展示。 */
  read(ref: string, offset?: number, limit?: number): Promise<ContextContent>
  /** 有限重设租期。 */
  retain(ref: string, turns: ScriptRetention, signal?: AbortSignal): Promise<ResultRetained>
  /** 装配观察结果、有效租约、最小事实；原始事实仍由现有视图管理。 */
  project(
    view: ModelView,
    observation: Optional<ContextRef>,
    images: readonly ModelImage[],
    signal: AbortSignal,
    maxChars?: number,
    retained?: ReadonlyArray<Pick<SegmentEntry, 'ref' | 'outputViews' | 'fullMaterial'>>
  ): Promise<{
    body: string
    images: readonly ModelImage[]
    prompt: string
    /** 租约有效、但因本帧容量放不下而没有列出的结果。 */
    squeezed: readonly string[]
    /** 只供宿主按当前实际历史逐块核对覆盖，不进入帧正文。 */
    outputCoverage?: readonly SegmentOutputCoverage[]
    /** 宿主投影预算；旧注入缺省时保持未知，不进入模型正文。 */
    budget?: {
      maxChars: number
      resultBudgetChars: number
      excerptChars: number
      visibleResults: number
    }
  }>
  /** 显式释放材料可见性，原始记录保持。 */
  release(ref: string, signal?: AbortSignal): Promise<ResultReleased>
  /** 释放已随历史封段的 segment 租约，不影响显式轮数和 task 租约。 */
  endSegment(refs: readonly string[], signal: AbortSignal): Promise<void>
  /** 结束逻辑任务的 segment 和 task 期限。 */
  endTask(): Promise<void>
  /** 历史投影进一步裁剪后，只确认实际携带正文的引用。 */
  delivered(frameId: string, refs: readonly string[], signal: AbortSignal): Promise<void>
  /** 成功业务回合扣减一次，同一帧幂等。 */
  consume(frameId: string, signal: AbortSignal): Promise<void>
}

/** 程序选择与可见租约使用原有会话审计记录，正文始终按引用召回。 */
export class ProgramContext implements ProgramContextApi {
  public readonly catalog: ProgramCatalogPort = {
    publish: (input, signal) => this.catalogPublish(input, signal),
    list: (input, signal) => this.catalogList(input, signal),
    describe: (input, signal) => this.catalogDescribe(input, signal),
  }

  public constructor(
    private readonly sessionId: string,
    private readonly context: ContextRuntime,
    private readonly storage: ContextStorage,
    private readonly catalogValidator?: ProgramCatalogValidator
  ) {}

  private async catalogPublish(
    request: ProgramPublishInput,
    signal: AbortSignal
  ): Promise<ProgramDescriptor> {
    const input = catalogPublication(request)
    if (!this.catalogValidator)
      throw AppError.withFields('UNAVAILABLE', '程序检查端口未装配', { effect: 'none' })
    const program: CodeProgramRequest = { source: input.source, modules: input.modules }
    let dependencies: readonly ModuleBinding[]
    try {
      dependencies = await this.catalogValidator.validate(program, signal)
    } catch (error) {
      const failure = AppError.from(error)
      throw AppError.withFields(failure.code, failure.message, { effect: 'none' })
    }
    const sourceRef = (await createContextReference(this.storage, this.sessionId)).id
    const descriptor: ProgramDescriptor = {
      name: input.name,
      revision: (input.baseRevision ?? 0) + 1,
      purpose: input.purpose,
      inputDescription: input.inputDescription,
      sourceRef,
      contentRevision: scriptOutputs.hash(program),
      dependencies,
    }
    const additions = [
      await this.record(`script:${sourceRef}`, JSON.stringify(program), sourceRef),
      await this.record(
        `script:version:${sourceRef}`,
        JSON.stringify({ sourceRef, baseObservation: null, kind: 'execution' }),
        undefined,
        [{ sessionId: this.sessionId, id: sourceRef }]
      ),
      await this.record(`script:catalog:${sourceRef}`, JSON.stringify(descriptor), undefined, [
        { sessionId: this.sessionId, id: sourceRef },
      ]),
    ]
    await this.update(
      (state, reset) => {
        const catalog = state.programCatalogReset === reset ? state.programCatalog : undefined
        const previous = catalog?.[input.name]
        if ((previous?.revision ?? 0) !== (input.baseRevision ?? 0))
          throw AppError.withFields(
            'CONFLICT',
            '程序名称版本已经变化；读取当前 revision 后再发布',
            { effect: 'none' }
          )
        return {
          ...state,
          programCatalogReset: reset,
          programCatalog: { ...catalog, [input.name]: descriptor },
        }
      },
      additions,
      signal
    )
    return descriptor
  }

  private async catalogAvailable(
    descriptor: ProgramDescriptor,
    signal: AbortSignal
  ): Promise<boolean> {
    if (!this.catalogValidator) return false
    try {
      const snapshot = await this.snapshot([
        { refId: descriptor.sourceRef },
        { title: 'search:history-reset', latest: true },
      ])
      const source = snapshot?.records.find((item) => item.ref.id === descriptor.sourceRef)
      const reset = Math.max(
        snapshot?.metadata.task?.startedSequence ?? 0,
        snapshot?.records.findLast((item) => item.title === 'search:history-reset')?.sequence ?? 0
      )
      if (!source || source.sequence <= reset) return false
      const material = await this.readProgram(descriptor.sourceRef, 0, 1)
      if (await this.catalogValidator.unchanged(descriptor.dependencies, signal)) return true
      const raw = await this.storage.get(this.sessionId, material.record.objectId)
      if (isNull(raw)) return false
      await this.catalogValidator.validate(JSON.parse(raw), signal)
      return true
    } catch (error) {
      signal.throwIfAborted()
      Log.tag('ActRuntime').debug('程序目录项未通过当前授权检查', { error })
      return false
    }
  }

  private async catalogList(input: ProgramQuery, signal: AbortSignal): Promise<ProgramPage> {
    const { query, offset, limit } = catalogQuery(input)
    const items: ProgramDescriptor[] = []
    for (const descriptor of Object.values((await this.state()).programCatalog ?? {})) {
      signal.throwIfAborted()
      if (
        query &&
        !`${descriptor.name}\n${descriptor.purpose}`.toLowerCase().includes(query.toLowerCase())
      )
        continue
      if (await this.catalogAvailable(descriptor, signal)) items.push(descriptor)
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    return {
      items: items.slice(offset, offset + limit),
      nextOffset: offset + limit < items.length ? offset + limit : null,
    }
  }

  private async catalogDescribe(
    input: ProgramDescribeInput,
    signal: AbortSignal
  ): Promise<ProgramDescriptor> {
    if (
      !isPlainObject(input) ||
      Object.keys(input).length !== 1 ||
      !('name' in input ? isString(input.name) : 'sourceRef' in input && isString(input.sourceRef))
    )
      throw new AppError('VALIDATION', 'describe 需要 name 或 sourceRef')
    let descriptor: Optional<ProgramDescriptor>
    if ('name' in input) descriptor = (await this.state()).programCatalog?.[input.name]
    else {
      const record = (
        await this.snapshot([{ title: `script:catalog:${input.sourceRef}`, latest: true }])
      )?.records.findLast((item) => item.title === `script:catalog:${input.sourceRef}`)
      const raw = record ? await this.storage.get(this.sessionId, record.objectId) : null
      if (!isNull(raw)) descriptor = JSON.parse(raw)
    }
    if (!descriptor || !(await this.catalogAvailable(descriptor, signal)))
      throw new AppError('NOT_FOUND', '当前授权与重置范围内没有该程序')
    return descriptor
  }

  public async observationCollection(
    collection: ObservationCollection,
    refresh?: string
  ): Promise<void> {
    await this.update((state) =>
      state.observation === collection.sourceRef
        ? {
            ...state,
            observationCollection: collection,
            observationRefresh:
              refresh && state.observationRefresh === refresh
                ? undefined
                : state.observationRefresh,
          }
        : state
    )
  }

  public async observeHealth(
    sourceRef: string,
    resultRef: string,
    success: boolean,
    uncertain: boolean
  ): Promise<void> {
    await this.update((state) => {
      if (state.observation !== sourceRef) return state
      const previous = state.health?.sourceRef === sourceRef ? state.health : undefined
      const failures = success ? 0 : (previous?.failures ?? 0) + 1
      return {
        ...state,
        health: {
          sourceRef,
          lastResult: resultRef,
          lastSuccess: success ? resultRef : previous?.lastSuccess,
          failures,
          status:
            uncertain || failures >= ActRuntimeTuning.observationFailures
              ? 'paused'
              : success
                ? 'healthy'
                : 'degraded',
          reason: !success ? (uncertain ? 'effect-unknown' : 'collection-failed') : undefined,
        },
      }
    })
  }

  public async state(): Promise<ProgramLeaseState> {
    return this.readState(
      await this.snapshot([
        { title: 'script:lease-state', kind: 'audit', latest: true },
        { title: 'search:history-reset', latest: true },
      ])
    )
  }

  private async snapshot(
    selections: readonly ContextRecordSelection[],
    incremental = false
  ): Promise<Nullable<ContextRecordSnapshot>> {
    if (this.storage.selectSnapshot && (!incremental || this.storage.compareAndSwapMetadata))
      return this.storage.selectSnapshot(this.sessionId, selections)
    const state = await this.storage.load(this.sessionId)
    if (!state) return null
    const { records, ...metadata } = state
    return { metadata, records }
  }

  /** 只接受宿主登记的原样页对象；读取回执自身不是已交付证明。 */
  private async readDelivery(
    value: unknown,
    carrierRef: string,
    signal: AbortSignal,
    beforeSequence?: number,
    depth = 0
  ): Promise<readonly SegmentOutputProof[]> {
    // 每一步还必须回到更早的不可变源记录；有界遍历对异常宿主链保守停止。
    if (!isPlainObject(value) || depth >= 32) return []
    const page = value
    const delivery = page.delivery as { receipt?: ContextRef } | undefined
    const receipt = delivery?.receipt
    if (!receipt || receipt.sessionId !== this.sessionId || !isString(receipt.id)) return []
    const snapshot = await this.snapshot([
      { refId: receipt.id },
      { title: 'search:history-reset', latest: true },
    ])
    signal.throwIfAborted()
    const record = snapshot?.records.find((item) => item.ref.id === receipt.id)
    const reset = Math.max(
      snapshot?.metadata.task?.startedSequence ?? 0,
      snapshot?.records.findLast((item) => item.title === 'search:history-reset')?.sequence ?? 0
    )
    if (
      !record ||
      record.kind !== 'audit' ||
      record.title !== 'memory:read-delivery' ||
      record.sequence <= reset ||
      (!isUndefined(beforeSequence) && record.sequence >= beforeSequence)
    )
      return []
    const raw = await this.storage.get(this.sessionId, record.objectId)
    if (isNull(raw)) return []
    const bound = JSON.parse(raw) as MemoryReadDelivery
    const { delivery: _delivery, ...content } = page
    if (
      bound.authorizationSequence !== reset ||
      bound.source.sessionId !== this.sessionId ||
      scriptOutputs.hash(content) !== bound.pageHash ||
      !isString(content.text) ||
      content.text.length !== bound.chars ||
      content.offset !== bound.offset ||
      content.totalChars !== bound.totalChars ||
      content.pointer !== bound.pointer ||
      !Number.isSafeInteger(bound.offset) ||
      !Number.isSafeInteger(bound.chars) ||
      !Number.isSafeInteger(bound.totalChars) ||
      bound.offset < 0 ||
      bound.chars < 0 ||
      bound.offset + bound.chars > bound.totalChars ||
      !record.sources.some(
        (source) => source.sessionId === bound.source.sessionId && source.id === bound.source.id
      )
    )
      return []
    // 回执绑定不可变原块；只把整块 value 或整份归档的同表示范围交给当前历史聚合。
    const proofs: SegmentOutputProof[] = bound.blocks.map((block) => {
      const pointer: { pointer?: string } = {}
      if (bound.pointer) pointer.pointer = bound.pointer
      return {
        ref: bound.source.id,
        key: block.key,
        contentHash: block.contentHash,
        carrierRef,
        range: {
          ...pointer,
          offset: bound.offset,
          chars: bound.chars,
          totalChars: bound.totalChars,
        },
      }
    })
    // 只从整块 value 的原样归档取出下一页，不解析模型生成的 JSON 或裸正文。
    const match = bound.pointer?.match(/^\/output\/blocks\/(0|[1-9]\d*)\/value$/u)
    if (!match || bound.offset !== 0 || bound.chars !== bound.totalChars) return proofs
    const sourceSnapshot = await this.snapshot([
      { refId: bound.source.id },
      { title: 'search:history-reset', latest: true },
    ])
    signal.throwIfAborted()
    const sourceRecord = sourceSnapshot?.records.find(
      (item) => item.ref.id === bound.source.id && item.ref.sessionId === this.sessionId
    )
    const sourceReset = Math.max(
      sourceSnapshot?.metadata.task?.startedSequence ?? 0,
      sourceSnapshot?.records.findLast((item) => item.title === 'search:history-reset')?.sequence ??
        0
    )
    if (
      !sourceRecord ||
      sourceRecord.kind !== 'audit' ||
      !/^script:[^:]+:result$/u.test(sourceRecord.title) ||
      sourceRecord.sequence >= record.sequence ||
      sourceReset !== reset
    )
      return proofs
    const source = await this.storage.get(this.sessionId, sourceRecord.objectId)
    signal.throwIfAborted()
    if (isNull(source)) return proofs
    const archived = JSON.parse(source)
    const block =
      isPlainObject(archived.output) && isArray(archived.output.blocks)
        ? archived.output.blocks[Number(match[1])]
        : undefined
    if (
      !isPlainObject(block) ||
      !isPlainObject(block.value) ||
      !bound.blocks.some(
        (item) => item.key === block.key && item.contentHash === scriptOutputs.hash(block.value)
      ) ||
      content.text !== JSON.stringify(block.value)
    )
      return proofs
    proofs.push(
      ...(await this.readDelivery(
        block.value,
        carrierRef,
        signal,
        sourceRecord.sequence,
        depth + 1
      ))
    )
    return proofs
  }

  private async readState(snapshot: Nullable<ContextRecordSnapshot>): Promise<ProgramLeaseState> {
    const record = snapshot?.records.findLast(
      (item) => item.kind === 'audit' && item.title === 'script:lease-state'
    )
    if (!record || record.sequence <= (snapshot?.metadata.task?.startedSequence ?? 0))
      return { completedTurns: 0, leases: [] }
    const body = await this.storage.get(this.sessionId, record.objectId)
    if (isNull(body)) throw new AppError('NOT_FOUND', '程序租约记录缺失')
    const state = JSON.parse(body) as ProgramLeaseState
    const reset = Math.max(
      snapshot?.metadata.task?.startedSequence ?? 0,
      snapshot?.records.findLast((item) => item.title === 'search:history-reset')?.sequence ?? 0
    )
    return state.observationSnapshot && state.observationSnapshotReset !== reset
      ? {
          ...state,
          observation: undefined,
          observationSnapshot: undefined,
          observationSnapshotReset: undefined,
          observationRefresh: undefined,
          observationCollection: undefined,
          health: undefined,
        }
      : state
  }

  private async update(
    change: (state: ProgramLeaseState, reset: number) => ProgramLeaseState,
    additions: readonly ContextRecord[] = [],
    signal?: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt++) {
      signal?.throwIfAborted()
      const incremental = Boolean(
        this.storage.selectSnapshot && this.storage.compareAndSwapMetadata
      )
      const refs = [
        ...new Set(
          additions.flatMap((item) => [item.ref.id, ...item.sources.map((ref) => ref.id)])
        ),
      ]
      const snapshot = (await this.snapshot(
        [
          { title: 'script:lease-state', kind: 'audit', latest: true },
          { title: 'search:history-reset', latest: true },
          ...refs.map((refId) => ({ refId })),
        ],
        true
      )) ?? {
        metadata: {
          version: 0,
          objectReferencesVersion: 1,
          workingSet: { revision: 0, cursor: 0, items: [] },
        },
        records: [],
      }
      if (additions.some((item) => snapshot.records.some((old) => old.ref.id === item.ref.id)))
        throw new AppError('SCRIPT_REPLAY', '控制调用已经提交')
      const available = new Set([...snapshot.records, ...additions].map((item) => item.ref.id))
      if (
        additions.some((item) =>
          item.sources.some((ref) => ref.sessionId !== this.sessionId || !available.has(ref.id))
        )
      )
        throw new AppError('SCRIPT_REF', '提交包含未知或跨会话来源')
      const previous = await this.readState(snapshot)
      const changed = change(
        previous,
        Math.max(
          snapshot.metadata.task?.startedSequence ?? 0,
          snapshot.records.findLast((item) => item.title === 'search:history-reset')?.sequence ?? 0
        )
      )
      const identities = new Set(previous.leases.map((item) => item.ref))
      const state = {
        ...changed,
        resultsRevision:
          (previous.resultsRevision ?? 0) +
          (changed.leases.some((item) => !identities.has(item.ref)) ? 1 : 0),
      }
      const record = await this.record('script:lease-state', JSON.stringify(state))
      const metadata = { ...snapshot.metadata, version: snapshot.metadata.version + 1 }
      signal?.throwIfAborted()
      if (incremental) {
        if (
          await this.storage.compareAndSwapMetadata!(
            this.sessionId,
            snapshot.metadata.version,
            metadata,
            [...additions, record]
          )
        )
          return
      } else {
        const records = [
          ...snapshot.records,
          ...[...additions, record].map((item, index) => ({
            ...item,
            sequence: (snapshot.records.at(-1)?.sequence ?? 0) + index + 1,
          })),
        ]
        if (
          await this.storage.compareAndSwap(this.sessionId, snapshot.metadata.version, {
            ...metadata,
            records,
          })
        )
          return
      }
    }
    throw new AppError('SCRIPT_BUSY', '上下文持续发生并发变化，请重新读取当前版本')
  }

  private async record(
    title: string,
    body: string,
    id: Optional<string> = undefined,
    sources: readonly ContextRef[] = []
  ): Promise<ContextRecord> {
    if (body.length > ContextLimits.objectChars)
      throw new AppError('TOO_LARGE', '程序记录超过上下文对象限制')
    const objectId = await this.storage.put(this.sessionId, body)
    return {
      ref: {
        sessionId: this.sessionId,
        id: id ?? (await createContextReference(this.storage, this.sessionId)).id,
      },
      sequence: 0,
      kind: 'audit',
      title,
      objectId,
      chars: body.length,
      sources,
      createdAt: new Date().toISOString(),
    }
  }

  public async version(ref: string): Promise<Optional<ScriptProgramVersion>> {
    const record = (
      await this.snapshot([{ title: `script:version:${ref}`, kind: 'audit', latest: true }])
    )?.records.findLast((item) => item.kind === 'audit' && item.title === `script:version:${ref}`)
    if (!record) return undefined
    const body = await this.storage.get(this.sessionId, record.objectId)
    if (isNull(body)) throw new AppError('NOT_FOUND', '程序版本记录缺失')
    return JSON.parse(body) as ScriptProgramVersion
  }

  public async receipt(control: ScriptControlIdentity): Promise<Optional<ScriptSubmissionReceipt>> {
    const record = (
      await this.snapshot([{ title: `script:control:${control.id}`, kind: 'audit', latest: true }])
    )?.records.findLast(
      (item) => item.kind === 'audit' && item.title === `script:control:${control.id}`
    )
    if (!record) return undefined
    const body = await this.storage.get(this.sessionId, record.objectId)
    if (isNull(body)) throw new AppError('NOT_FOUND', '控制提交回执缺失')
    const saved = JSON.parse(body) as { fingerprint: string; receipt: ScriptSubmissionReceipt }
    if (saved.fingerprint !== control.fingerprint)
      throw new AppError('SCRIPT_CALL_CONFLICT', '同一调用身份不能用于另一份输入')
    return saved.receipt
  }

  public async publish(
    prepared: readonly PreparedScript[],
    control: ScriptControlIdentity,
    input: ScriptSubmissionReceipt,
    activate: boolean,
    visible: boolean,
    signal: AbortSignal
  ): Promise<{ receipt: ScriptSubmissionReceipt; claimed: boolean }> {
    const receipt = JSON.parse(JSON.stringify(input)) as ScriptSubmissionReceipt
    const prior = await this.receipt(control)
    if (prior) return { receipt: prior, claimed: false }
    const additions: ContextRecord[] = []
    for (const { program, version } of prepared)
      if (program && version) {
        additions.push(
          await this.record(
            `script:${version.sourceRef}`,
            JSON.stringify(program),
            version.sourceRef
          )
        )
        additions.push(
          await this.record(
            `script:version:${version.sourceRef}`,
            JSON.stringify(version),
            undefined,
            [{ sessionId: this.sessionId, id: version.sourceRef }]
          )
        )
      }
    const refs = [
      ...new Set(
        [receipt.observe, receipt.execute, ...(receipt.executions ?? [])].flatMap((item) =>
          item
            ? [
                ('draftRef' in item ? item.draftRef : undefined) ??
                  item.sourceRef ??
                  item.parentRef,
              ].filter((ref): ref is string => Boolean(ref))
            : []
        )
      ),
    ].map((id) => ({ sessionId: this.sessionId, id }))
    const output = visible
      ? await this.record(`script:${control.id}:result`, JSON.stringify(receipt), undefined, refs)
      : undefined
    if (output) additions.push(output)
    additions.push(
      await this.record(
        `script:control:${control.id}`,
        JSON.stringify({ fingerprint: control.fingerprint, receipt }),
        control.id,
        refs
      )
    )
    try {
      await this.update(
        (state, reset) => {
          if (activate && toNullable(state.observation) !== control.expectedObservation)
            throw AppError.withFields(
              'SCRIPT_CONFLICT',
              '观察版本已经变化，请基于 currentRef 继续编辑',
              { currentRef: toNullable(state.observation) }
            )
          const jobs = (receipt.status === 'prepared' ? (receipt.executions ?? []) : [])
            .filter((item) => item.executionId && item.sourceRef)
            .map((item) => ({
              executionId: item.executionId!,
              sourceRef: item.sourceRef!,
              batchId: control.id,
              status: 'queued' as const,
            }))
          return {
            ...state,
            jobs: !isEmpty(jobs) ? [...(state.jobs ?? []), ...jobs] : state.jobs,
            ...(activate
              ? {
                  observation: receipt.observe!.sourceRef,
                  observationSnapshot: prepared.find(
                    (item) => item.version?.sourceRef === receipt.observe!.sourceRef
                  )?.version?.snapshot
                    ? true
                    : receipt.observe!.sourceRef === state.observation
                      ? state.observationSnapshot
                      : undefined,
                  observationSnapshotReset: prepared.find(
                    (item) => item.version?.sourceRef === receipt.observe!.sourceRef
                  )?.version?.snapshot
                    ? reset
                    : receipt.observe!.sourceRef === state.observation
                      ? state.observationSnapshotReset
                      : undefined,
                  observationRefresh: receipt.observe!.refresh
                    ? control.id
                    : receipt.observe!.sourceRef === state.observation
                      ? state.observationRefresh
                      : undefined,
                  observationCollection:
                    receipt.observe!.sourceRef === state.observation
                      ? state.observationCollection
                      : undefined,
                  health:
                    receipt.observe!.sourceRef === state.observation
                      ? state.health
                      : prepared.some(
                            (item) =>
                              item.version?.sourceRef === receipt.observe!.sourceRef &&
                              item.version?.presentationOnly
                          ) && state.health
                        ? { ...state.health, sourceRef: receipt.observe!.sourceRef! }
                        : undefined,
                }
              : {}),
            leases:
              output && refs[0]
                ? [
                    ...state.leases,
                    {
                      ref: output.ref.id,
                      sourceRef: refs[0].id,
                      executionId: control.id,
                      expiresAfter: state.completedTurns + ScriptLeaseLimits.defaultTurns,
                      leaseId: crypto.randomUUID(),
                    },
                  ]
                : state.leases,
          }
        },
        additions,
        signal
      )
    } catch (error) {
      if ((error as { code?: string }).code === 'SCRIPT_REPLAY')
        return { receipt: (await this.receipt(control))!, claimed: false }
      throw error
    }
    return { receipt, claimed: true }
  }

  public async editObservation(
    sourceRef: string,
    edit: ScriptOutputEdit,
    reason: string,
    signal: AbortSignal
  ): Promise<string> {
    const record = await this.readProgram(sourceRef, 0, 1)
    const original = JSON.parse(
      (await this.storage.get(this.sessionId, record.record.objectId))!
    ) as CodeProgramRequest
    const program = scriptOutputs.edit(original, edit)
    if (program.source === original.source) return sourceRef
    const next = (await createContextReference(this.storage, this.sessionId)).id
    const id = crypto.randomUUID()
    const version: ScriptProgramVersion = {
      sourceRef: next,
      parentRef: sourceRef,
      baseObservation: sourceRef,
      kind: 'observation',
      presentationOnly: true,
      reason,
    }
    const receipt: ScriptSubmissionReceipt = {
      status: 'completed',
      executed: false,
      observe: { status: 'updated', sourceRef: next, parentRef: sourceRef, executed: false },
    }
    await this.publish(
      [{ program, version, receipt: receipt.observe! }],
      { id, fingerprint: id, expectedObservation: sourceRef },
      receipt,
      true,
      false,
      signal
    )
    return next
  }

  public async finish(
    control: ScriptControlIdentity,
    input: ScriptSubmissionReceipt
  ): Promise<ScriptSubmissionReceipt> {
    const receipt = JSON.parse(JSON.stringify(input)) as ScriptSubmissionReceipt
    const prior = await this.receipt(control)
    if (!prior) throw new AppError('INVARIANT', '脚本提交尚未占位')
    if (prior.status !== 'prepared') return prior
    const record = await this.record(
      `script:control:${control.id}`,
      JSON.stringify({ fingerprint: control.fingerprint, receipt }),
      `${control.id}:completed`
    )
    try {
      await this.update((state) => state, [record])
    } catch (error) {
      if ((error as { code?: string }).code === 'SCRIPT_REPLAY')
        return (await this.receipt(control))!
      throw error
    }
    return receipt
  }

  public async add(
    ref: ContextRef,
    source: ContextRef,
    executionId: string,
    turns: ScriptRetention
  ): Promise<void> {
    if (
      turns !== 'task' &&
      turns !== 'segment' &&
      (!Number.isSafeInteger(turns) || turns < 1 || turns > ScriptLeaseLimits.maxTurns)
    )
      throw new AppError('VALIDATION', '结果租约超出范围')
    await this.update((state) => ({
      ...state,
      leases: [
        ...state.leases.filter(
          (item) =>
            (item.task || item.segment || item.expiresAfter > state.completedTurns) &&
            item.ref !== ref.id
        ),
        {
          ref: ref.id,
          sourceRef: source.id,
          executionId,
          expiresAfter: isNumber(turns) ? state.completedTurns + turns : state.completedTurns,
          task: turns === 'task' ? true : undefined,
          segment: turns === 'segment' ? true : undefined,
          leaseId: crypto.randomUUID(),
        },
      ],
    }))
  }

  public async job(job: ScriptJob): Promise<void> {
    await this.update((state) => ({
      ...state,
      jobs: [...(state.jobs ?? []).filter((item) => item.executionId !== job.executionId), job],
    }))
  }

  public async readProgram(
    ref: string,
    offset = 0,
    limit: number = ScriptLeaseLimits.resultChars
  ): Promise<ContextContent> {
    const result = await this.context.read(
      { sessionId: this.sessionId, id: ref },
      { offset, limit }
    )
    if (result.record.kind !== 'audit' || result.record.title !== `script:${ref}`)
      throw new AppError('SCRIPT_REF', '引用不是当前会话保存的脚本版本')
    return result
  }

  public async read(
    ref: string,
    offset = 0,
    limit: number = ScriptLeaseLimits.resultChars
  ): Promise<ContextContent> {
    const result = await this.context.read(
      { sessionId: this.sessionId, id: ref },
      { offset, limit }
    )
    if (
      result.record.kind !== 'audit' ||
      !/^script:(?:[a-f0-9]{8}|[0-9a-f-]{36}):result$/u.test(result.record.title)
    )
      throw new AppError('RESULT_REF', '引用不是当前会话的执行结果')
    return result
  }

  public async retain(
    ref: string,
    turns: ScriptRetention,
    signal?: AbortSignal
  ): Promise<ResultRetained> {
    signal?.throwIfAborted()
    const content = await this.read(ref)
    const source = content.record.sources[0]
    if (!source) throw new AppError('INVARIANT', '执行结果缺少源码引用')
    await this.add(content.record.ref, source, content.record.title.slice(7, -7), turns)
    return { ref, remainingTurns: turns, executed: false as const }
  }

  public async release(ref: string, signal?: AbortSignal): Promise<ResultReleased> {
    await this.read(ref)
    await this.update(
      (state) => ({
        ...state,
        leases: state.leases.filter((item) => item.ref !== ref),
        released: [...new Set([...(state.released ?? []), ref])],
      }),
      [],
      signal
    )
    return { ref, released: true as const, executed: false as const }
  }

  public async endSegment(refs: readonly string[], signal: AbortSignal): Promise<void> {
    const retired = new Set(refs)
    if (!retired.size) return
    await this.update(
      (state) => ({
        ...state,
        leases: state.leases.filter((item) => !item.segment || !retired.has(item.ref)),
      }),
      [],
      signal
    )
  }

  public async endTask(): Promise<void> {
    await this.update((state) => ({
      ...state,
      leases: state.leases.filter((item) => !item.task && !item.segment),
      ...(state.observationSnapshot
        ? {
            observation: undefined,
            observationSnapshot: undefined,
            observationSnapshotReset: undefined,
            observationRefresh: undefined,
            observationCollection: undefined,
            health: undefined,
          }
        : {}),
      released: undefined,
    }))
  }

  public async project(
    view: ModelView,
    observation: Optional<ContextRef>,
    observationImages: readonly ModelImage[],
    signal: AbortSignal,
    maxChars: number = ActRuntimeTuning.frameChars,
    retained: ReadonlyArray<Pick<SegmentEntry, 'ref' | 'outputViews' | 'fullMaterial'>> = []
  ): Promise<{
    body: string
    images: readonly ModelImage[]
    prompt: string
    squeezed: readonly string[]
    outputCoverage: readonly SegmentOutputCoverage[]
    budget: {
      maxChars: number
      resultBudgetChars: number
      excerptChars: number
      visibleResults: number
    }
  }> {
    const selected = await this.snapshot([
      { title: 'script:lease-state', kind: 'audit', latest: true },
      { title: 'search:history-reset', latest: true },
      { title: 'script:output-summaries', latest: true },
      ...(!isEmpty(view.goals)
        ? [
            {
              title: 'user:image',
              after: Math.max(0, Math.min(...view.goals.map((goal) => goal.record.sequence)) - 1),
            },
          ]
        : []),
      { titlePrefix: 'act:child:', latestPerTitle: true },
    ])
    const state = await this.readState(selected)
    const snapshot = selected ? { ...selected.metadata, records: selected.records } : null
    const frameId = (await createContextReference(this.storage, this.sessionId)).id
    const allVisible = state.leases.filter(
      (item) => item.task || item.segment || item.expiresAfter > state.completedTurns
    )
    const visible = allVisible.slice(-Math.max(1, Math.min(64, Math.floor(maxChars / 768))))
    const resultBudgetChars = Math.max(1, Math.floor(maxChars / Math.max(1, visible.length) / 2))
    const excerptChars = Math.min(ScriptLeaseLimits.resultChars, resultBudgetChars)
    const images: ModelImage[] = []
    const reset = Math.max(
      snapshot?.records.findLast((record) => record.title === 'search:history-reset')?.sequence ??
        0,
      snapshot?.task?.startedSequence ?? 0
    )
    const taskRevision = scriptOutputs.hash([snapshot?.task?.goals ?? [], reset])
    const summaryRecord = snapshot?.records.findLast(
      (record) => record.title === 'script:output-summaries' && record.sequence > reset
    )
    const summaries: ScriptOutputSummary[] = summaryRecord
      ? JSON.parse((await this.storage.get(this.sessionId, summaryRecord.objectId))!)
      : []
    const imageReferences: Array<{
      ref: ContextRef
      attached: boolean
      read: { module: string; export: string; operation: string; input: { ref: ContextRef } }
    }> = []
    for (const record of snapshot?.records ?? [])
      if (
        record.title === 'user:image' &&
        record.sources.some((ref) =>
          view.goals.some(
            (goal) => goal.record.ref.id === ref.id && goal.record.ref.sessionId === ref.sessionId
          )
        )
      ) {
        const data = await this.storage.get(this.sessionId, record.objectId)
        if (isNull(data)) throw new AppError('NOT_FOUND', '用户图片记录缺失')
        images.push(JSON.parse(data) as ModelImage)
        imageReferences.push({
          ref: record.ref,
          attached: true,
          read: {
            module: 'velaros:system',
            export: 'memory',
            operation: 'read',
            input: { ref: record.ref },
          },
        })
      }
    const leaseMissing: Array<{
      key: string
      ref: string
      reason: string
      contentHash: string
      read: { ref: string; pointer: string }
    }> = []
    for (const lease of allVisible.filter(
      (item) => !visible.some((current) => current.ref === item.ref)
    )) {
      const result = await this.read(lease.ref, 0, 1)
      const archived = JSON.parse((await this.storage.get(this.sessionId, result.record.objectId))!)
      for (const [index, block] of (archived.output?.blocks ?? []).entries())
        if (block.options.required)
          leaseMissing.push({
            key: block.key,
            ref: lease.ref,
            reason: 'required-lease-not-delivered',
            contentHash: scriptOutputs.hash(block.value),
            read: { ref: lease.ref, pointer: `/output/blocks/${index}/value` },
          })
    }
    const prepared = await Promise.all(
      visible.map(async (lease) => {
        signal.throwIfAborted()
        const [result, source] = await Promise.all([
          this.read(lease.ref, 0, excerptChars),
          this.context.read(
            { sessionId: this.sessionId, id: lease.sourceRef },
            { limit: ActRuntimeTuning.readChars }
          ),
        ])
        const sourceText = programContentText(source, true)
        const full = await this.storage.get(this.sessionId, result.record.objectId)
        if (isNull(full)) throw new AppError('NOT_FOUND', '结果归档正文缺失')
        const archived = JSON.parse(full)
        const output = archived.output as Optional<ScriptOutputCapture>
        const managed = Boolean(
          output &&
          (Object.keys(output.config).length ||
            output.blocks.some((block) => Object.keys(block.options).length))
        )
        const recalled = new Map<string, readonly SegmentOutputProof[]>()
        const displays: ScriptOutputDisplay[] = []
        for (const block of output?.blocks ?? []) {
          const proofs = await this.readDelivery(block.value, lease.ref, signal)
          if (isEmpty(proofs)) continue
          recalled.set(block.key, proofs)
          const { text, ...metadata } = block.value as Record<string, unknown> & { text: string }
          displays.push({
            key: block.key,
            contentHash: scriptOutputs.hash(block.value),
            text: `${JSON.stringify({ encoding: 'memory-page', page: metadata, textChars: text.length })}\n${text}`,
          })
        }
        const requested = output ? scriptOutputs.requestBudget(output) : undefined
        const preferred = managed
          ? scriptOutputs.project(
              output!,
              lease.ref,
              requested!.explicit ? ActRuntimeTuning.frameChars : excerptChars,
              undefined,
              summaries,
              taskRevision,
              'text',
              displays
            )
          : undefined
        // 保留历史来自本次真实候选；重置后的记录、观察结果或不同表示均不覆盖当前输出。
        const previous =
          result.record.sequence > reset && archived.mode !== 'observe'
            ? (retained.find((entry) => entry.ref === lease.ref)?.outputViews ?? [])
            : []
        const covered = preferred
          ? programCoveredOutputs(this.sessionId, lease.ref, lease.sourceRef, preferred, previous)
          : []
        const reduced = preferred ? scriptOutputs.withoutBodies(preferred, covered) : undefined
        const rawMaterial = managed ? undefined : executionMaterial(archived)
        const materialIdentity = rawMaterial
          ? scriptOutputs.hash([this.sessionId, lease.ref, lease.sourceRef, rawMaterial])
          : undefined
        const rawInHistory = Boolean(
          materialIdentity &&
          result.record.sequence > reset &&
          archived.mode !== 'observe' &&
          !archived.attachments?.length &&
          retained.some(
            (entry) => entry.ref === lease.ref && entry.fullMaterial === materialIdentity
          )
        )
        return {
          lease,
          result,
          source,
          sourceText,
          full,
          archived,
          output,
          recalled,
          displays,
          preferred,
          reduced,
          previous,
          rawMaterial,
          materialIdentity,
          rawInHistory,
          demand: rawInHistory
            ? 0
            : (reduced?.prompt.length ??
              Math.min(ScriptLeaseLimits.resultChars, rawMaterial!.length)),
        }
      })
    )
    const resultBudgets = allocateProgramResultBudgets(
      prepared.map((item) => item.demand),
      resultBudgetChars
    )
    const outputCoverage: SegmentOutputCoverage[] = []
    const results: Array<
      ReturnType<typeof projectMaterial> & {
        ref: string
        sourceRef: string
        source: string
        sourceTruncated: boolean
        structuredOutput?: boolean
        outputFormat?: ScriptOutputFormat
        outputProofs?: readonly SegmentOutputProof[]
        outputViews?: readonly SegmentOutputView[]
        bodyInHistory?: boolean
        materialCoverage?: { identity: string; complete: boolean }
        remainingTurns: ScriptRetention
        observedAt: string
        totalChars: number
        truncated: boolean
        location: { executionId: string; pointer: string }
        read: { module: string; export: string; operation: string; ref: string; rangeUnit: string }
      }
    > = []
    let feedback: Optional<{
      ref: string
      sourceRef: string
      failure?: NonNullable<ReturnType<typeof programFailure>>
      recovery?: { index: { ref: string; pointer: string }; selector: 'invocation' }
    }>
    for (const [index, item] of prepared.entries()) {
      signal.throwIfAborted()
      const {
        lease,
        result,
        source,
        sourceText,
        full,
        archived,
        output,
        recalled,
        displays,
        preferred,
        reduced,
        previous,
        rawMaterial,
        materialIdentity,
        rawInHistory,
      } = item
      const failure = programFailure(archived)
      feedback =
        failure || archived.recovery?.calls?.length
          ? {
              ref: lease.ref,
              sourceRef: lease.sourceRef,
            }
          : undefined
      if (feedback) {
        if (failure) feedback.failure = failure
        if (archived.recovery?.calls?.length)
          feedback.recovery = {
            index: { ref: lease.ref, pointer: '/recovery/calls' },
            selector: 'invocation',
          }
      }
      // 短回执的余量交给需要正文的结果；同帧总池与默认单结果上限保持有界。
      const assigned = resultBudgets[index]!
      // 短结果按实际编码归账，但保留原展示上限；预算头仍描述本帧真实份额，不把用量当配置。
      const allowance = Math.max(resultBudgetChars, assigned)
      const rendered = preferred
        ? allowance >= reduced!.prompt.length
          ? preferred
          : scriptOutputs.project(
              output!,
              lease.ref,
              allowance + Math.max(0, preferred.prompt.length - reduced!.prompt.length),
              undefined,
              summaries,
              taskRevision,
              'text',
              displays
            )
        : undefined
      // 需求试投影的覆盖不能借给不同的最终片段；重新核对本帧真实表示的逐块身份。
      const finalCovered = rendered
        ? programCoveredOutputs(this.sessionId, lease.ref, lease.sourceRef, rendered, previous)
        : []
      const display: Optional<ScriptOutputProjection> = rendered
        ? scriptOutputs.withoutBodies(rendered, finalCovered, allowance)
        : undefined
      const hasNative =
        display?.blocks.some(
          (block) =>
            block.type === 'image' &&
            block.reason === 'native-attachment-required' &&
            archived.outputAttachments?.some((entry: { key: string }) => entry.key === block.key)
        ) && maxChars > 6000
      const projected = display
        ? {
            text: display.prompt,
            representation:
              display.blocks.every((block) => block.representation === 'full') &&
              !display.omittedBlocks
                ? ('full' as const)
                : ('excerpt' as const),
            bodyIncluded: Boolean(hasNative) || display.blocks.some((block) => block.bodyIncluded),
            size: {
              storedBytes: new TextEncoder().encode(full).length,
              chars: full.length,
              unit: 'utf16',
            },
            omitted: display.blocks
              .filter((block) => !block.bodyIncluded)
              .map((block) => block.pointer),
          }
        : projectMaterial(
            rawMaterial!,
            result.record.ref,
            rawInHistory ? 0 : Math.min(ScriptLeaseLimits.resultChars, allowance)
          )
      for (const [index, block] of (output?.blocks ?? []).entries())
        if (block.options.required) {
          const rendered = display?.blocks.find((item) => item.key === block.key)
          const native =
            rendered?.type === 'image' &&
            rendered.reason === 'native-attachment-required' &&
            maxChars > 6000 &&
            archived.outputAttachments?.some((entry: { key: string }) => entry.key === block.key)
          if (rendered?.representation !== 'full' && !native)
            leaseMissing.push({
              key: block.key,
              ref: lease.ref,
              reason: 'required-body-unavailable',
              contentHash: scriptOutputs.hash(block.value),
              read: { ref: lease.ref, pointer: `/output/blocks/${index}/value` },
            })
        }
      const outputProofs: SegmentOutputProof[] = []
      for (const block of display?.blocks ?? []) {
        if (block.representation !== 'full' || !block.bodyIncluded) continue
        const original = output?.blocks.find((entry) => entry.key === block.key)
        if (!original) continue
        if (original.options.required)
          outputProofs.push({ ref: lease.ref, key: block.key, contentHash: block.contentHash })
        outputProofs.push(...(recalled.get(block.key) ?? []))
      }
      if (display)
        outputCoverage.push({
          ref: lease.ref,
          projection: display,
          keys: (output?.blocks ?? [])
            .filter((block) => {
              const view = block.options.view ?? {}
              return (
                view.mode !== 'summary' &&
                view.mode !== 'reference' &&
                !view.paths &&
                !view.lines &&
                isUndefined(view.maxItems) &&
                isUndefined(view.edge)
              )
            })
            .map((block) => block.key),
        })
      results.push({
        ref: lease.ref,
        sourceRef: lease.sourceRef,
        source: sourceText.slice(0, excerptChars),
        sourceTruncated: sourceText.length > excerptChars || source.text.length < source.totalChars,
        remainingTurns: lease.task
          ? 'task'
          : lease.segment
            ? 'segment'
            : lease.expiresAfter - state.completedTurns,
        observedAt: result.record.createdAt,
        structuredOutput: display ? true : undefined,
        outputFormat: display?.format,
        outputProofs,
        outputViews: display
          ? programOutputViews(this.sessionId, lease.ref, lease.sourceRef, display)
          : undefined,
        bodyInHistory:
          rawInHistory ||
          (display &&
            !rendered?.omittedBlocks &&
            finalCovered.length > 0 &&
            !display.omittedBlocks &&
            display.blocks.every((block) =>
              finalCovered.some(
                (entry) => entry.key === block.key && entry.contentHash === block.contentHash
              )
            ))
            ? true
            : undefined,
        materialCoverage: rawMaterial
          ? {
              identity: materialIdentity!,
              complete: projected.representation === 'full',
            }
          : undefined,
        ...projected,
        totalChars: result.totalChars,
        truncated: projected.representation !== 'full',
        location: { executionId: lease.executionId, pointer: '/' },
        read: {
          module: 'velaros:system',
          export: 'memory',
          operation: 'read',
          ref: lease.ref,
          rangeUnit: 'utf16',
        },
      })
      // 图像按自己的完整性限制读取，不把截取的 JSON 当完整结果解析。
      const saved = JSON.parse(full!) as {
        attachments?: ContextRef[]
        outputAttachments?: ReadonlyArray<{ key: string; index: number }>
      }
      const attached = (index: number) => {
        const binding = saved.outputAttachments?.find((item) => item.index === index)
        return (
          maxChars > 6000 &&
          (binding
            ? Boolean(
                display?.blocks.some(
                  (block) =>
                    block.key === binding.key && block.reason === 'native-attachment-required'
                )
              )
            : projected.bodyIncluded)
        )
      }
      for (const [index, ref] of (saved.attachments ?? []).entries())
        imageReferences.push({
          ref,
          attached: attached(index),
          read: { module: 'velaros:system', export: 'memory', operation: 'read', input: { ref } },
        })
      for (const ref of (saved.attachments ?? []).filter((_ref, index) => attached(index))) {
        const record = await this.context.read(ref, { limit: 1 })
        const image = await this.storage.get(this.sessionId, record.record.objectId)
        if (isNull(image)) throw new AppError('NOT_FOUND', '结果图像缺失')
        images.push(JSON.parse(image) as ModelImage)
      }
    }
    const source = state.observation
      ? await this.context.read(
          { sessionId: this.sessionId, id: state.observation },
          { limit: ActRuntimeTuning.readChars }
        )
      : undefined
    const current = observation
      ? await this.context.read(observation, { limit: ActRuntimeTuning.readChars })
      : undefined
    const previous = state.previousObservation
      ? await this.context.read(
          { sessionId: this.sessionId, id: state.previousObservation },
          { limit: ActRuntimeTuning.readChars }
        )
      : undefined
    const oldSourceRef = state.previousObservationSource
      ? { sessionId: this.sessionId, id: state.previousObservationSource }
      : previous?.record.sources[0]
    const oldSource = oldSourceRef
      ? await this.context.read(oldSourceRef, { limit: ActRuntimeTuning.readChars })
      : undefined
    const original = current
      ? JSON.parse((await this.storage.get(this.sessionId, current.record.objectId))!)
      : undefined
    const capture = original?.output as Optional<ScriptOutputCapture>
    const savedProgram = source
      ? (JSON.parse(
          (await this.storage.get(this.sessionId, source.record.objectId))!
        ) as CodeProgramRequest)
      : undefined
    const sourceText = savedProgram?.source ?? programContentText(source, true)
    const manifest = savedProgram ? scriptOutputs.describe(savedProgram) : undefined
    const managed =
      capture &&
      (Object.keys(capture.config).length ||
        capture.blocks.some((block) => Object.keys(block.options).length) ||
        (manifest && Object.keys(manifest.config).length))
    const presentation = managed
      ? scriptOutputs.project(
          capture,
          current!.record.ref.id,
          Math.max(excerptChars, Math.floor(maxChars / 2)),
          manifest,
          summaries,
          taskRevision,
          'text'
        )
      : undefined
    const resultText = presentation ? presentation.prompt : programContentText(current)
    const observedVersion = state.observation ? await this.version(state.observation) : undefined
    const previousOriginal = previous
      ? JSON.parse((await this.storage.get(this.sessionId, previous.record.objectId))!)
      : undefined
    const previousBlocks = (previousOriginal?.output?.blocks ?? []) as ScriptOutputCapture['blocks']
    const outputChanges = capture
      ? capture.blocks.map((block) => {
          const old = previousBlocks.find((item) => item.key === block.key)
          return {
            key: block.key,
            contentHash: scriptOutputs.hash(block.value),
            change: !old
              ? 'added'
              : scriptOutputs.hash(old.value) === scriptOutputs.hash(block.value)
                ? 'unchanged'
                : 'updated',
          }
        })
      : []
    const sourceKeys = manifest?.outputs.map((item) => item.key) ?? []
    const missingOutputs = sourceKeys
      .filter((key) => !capture?.blocks.some((block) => block.key === key))
      .map((key) => ({ key, status: 'not-produced' }))
    const exitedOutputs = previousBlocks
      .filter((old) => !capture?.blocks.some((block) => block.key === old.key))
      .map((old) => ({
        key: old.key,
        status: sourceKeys.includes(old.key) ? 'not-produced' : 'absent',
      }))
    const outputPresentation =
      presentation?.blocks.map((block) => ({
        key: block.key,
        representation: block.representation,
        contentHash: block.contentHash,
        policyHash: scriptOutputs.hash({
          config: manifest?.config ?? capture?.config,
          view:
            manifest?.outputs.find((item) => item.key === block.key)?.view ??
            capture?.blocks.find((item) => item.key === block.key)?.options.view ??
            {},
        }),
      })) ?? []
    const presentationChanges = outputPresentation
      .filter((block) =>
        state.previousOutputPresentation?.some(
          (old) =>
            old.key === block.key &&
            (old.representation !== block.representation || old.policyHash !== block.policyHash)
        )
      )
      .map((block) => ({
        key: block.key,
        from: state.previousOutputPresentation!.find((old) => old.key === block.key)!
          .representation,
        to: block.representation,
        reason: 'presentation-policy-or-budget',
      }))
    const observationAttached = (index: number) => {
      const binding = original?.outputAttachments?.find(
        (item: { index: number }) => item.index === index
      )
      return (
        maxChars > 6000 &&
        (!binding ||
          Boolean(
            presentation?.blocks.some(
              (block) => block.key === binding.key && block.reason === 'native-attachment-required'
            )
          ))
      )
    }
    images.push(...observationImages.filter((_image, index) => observationAttached(index)))
    const safety = current
      ? (JSON.parse((await this.storage.get(this.sessionId, current.record.objectId))!)
          .observationFeedback ?? [])
      : []
    if (current) {
      for (const [index, ref] of (original.attachments ?? []).entries())
        imageReferences.push({
          ref,
          attached: observationAttached(index),
          read: { module: 'velaros:system', export: 'memory', operation: 'read', input: { ref } },
        })
    }
    const required = new Map(
      [
        ...(capture?.blocks.map((block) => ({ ...block.options, key: block.key })) ?? []),
        ...(manifest?.outputs ?? []),
      ]
        .filter((item) => item.required)
        .map((item) => [item.key!, item])
    )
    const missingRequired = [...required.keys()]
      .filter((key) => {
        const displayed = presentation?.blocks.find((block) => block.key === key)
        return (
          !displayed ||
          !(
            displayed.representation === 'full' ||
            (displayed.type === 'image' &&
              original?.outputAttachments?.some(
                (entry: { key: string; index: number }) =>
                  entry.key === key && observationAttached(entry.index)
              ))
          )
        )
      })
      .map((key) => ({
        key,
        ref: toNullable(observation?.id),
        reason: !capture?.blocks.some((block) => block.key === key)
          ? 'not-produced'
          : 'required-body-unavailable',
      }))
    const previousRefs = state.previousVisible ?? []
    const currentRefs = results.map((item) => item.ref)
    const body = JSON.stringify({
      decision: {
        frameId,
        missing: [...leaseMissing, ...missingRequired],
      },
      id: view.id,
      scope: view.scope,
      goals: view.goals,
      capsule: view.capsule,
      children: await Promise.all(
        [
          ...new Map(
            (snapshot?.records ?? [])
              .filter((r) => r.title?.startsWith('act:child:') && r.sequence > reset)
              .map((r) => [r.title, r])
          ).values(),
        ].map(async (r) => JSON.parse((await this.storage.get(this.sessionId, r.objectId))!))
      ),
      mandatory: view.mandatory.filter(
        (item) =>
          item.effect === 'unknown' ||
          item.outcome === 'unknown' ||
          visible.some((lease) => lease.executionId === item.executionId)
      ),
      evidence: view.evidence,
      gaps: view.gaps,
      readSet: view.readSet,
      progress: {
        step: view.progress.step,
        repeatedSteps: view.progress.repeatedSteps,
        stalled: view.progress.stalled,
        script: programContentChange(oldSource, source, true),
        observation: programContentChange(previous, current),
        evidence: view.progress.evidence,
        feedback,
      },
      programFrame: {
        id: frameId,
        completedTurns: state.completedTurns,
        resultsRevision: state.resultsRevision ?? 0,
      },
      jobs: (state.jobs ?? []).filter(
        (item) =>
          ['queued', 'running', 'unknown'].includes(item.status) ||
          visible.some((lease) => lease.executionId === item.executionId)
      ),
      observation: {
        health: state.health,
        freshness: state.observationCollection,
        sourceRef: toNullable(state.observation),
        missingRequired,
        source: sourceText.slice(0, excerptChars),
        sourceTotalChars: sourceText.length,
        sourceTruncated:
          sourceText.length > excerptChars ||
          Boolean(source && source.text.length < source.totalChars),
        resultRef: toNullable(observation?.id),
        bodyIncluded: presentation
          ? presentation.blocks.some((block) => block.bodyIncluded) ||
            observationImages.some((_image, index) => observationAttached(index))
          : Boolean(resultText),
        resultSourceRef: toNullable(current?.record.sources[0]?.id),
        observedAt: current?.record.createdAt,
        text: presentation ? resultText : resultText.slice(0, excerptChars),
        totalChars: capture
          ? capture.blocks.reduce((sum, block) => sum + block.chars, 0)
          : resultText.length,
        truncated: presentation
          ? presentation.omittedBlocks > 0 ||
            presentation.blocks.some((block) => block.representation !== 'full')
          : resultText.length > excerptChars ||
            Boolean(current && current.text.length < current.totalChars),
        safety,
        ...(original
          ? {
              collection:
                original.error ||
                isFalse(original.checked) ||
                original.result?.failed ||
                capture?.issues.length
                  ? capture?.blocks.length
                    ? 'partial'
                    : 'failed'
                  : 'complete',
              collectionMetrics: original.metrics,
              collectionIssues: capture?.issues ?? [],
              failure:
                original.result?.failed ??
                original.error ??
                (isFalse(original.checked) ? (original.check ?? original.needsModules) : undefined),
              outputChanges,
              presentationChanges,
              missingOutputs,
              exitedOutputs,
            }
          : {}),
        ...(presentation
          ? {
              nativeImages: (original?.outputAttachments ?? []).map(
                (entry: { key: string; index: number }) => ({
                  key: entry.key,
                  attached: observationAttached(entry.index),
                  ref: original.attachments?.[entry.index],
                })
              ),
              presentation: {
                format: presentation.format,
                requestedChars: presentation.requestedChars,
                allocatedChars: presentation.allocatedChars,
                actualChars: presentation.prompt.length,
                omittedBlocks: presentation.omittedBlocks,
              },
              blocks: presentation.blocks.map(({ text: _text, ...metadata }) => ({
                ...metadata,
                attached:
                  metadata.type === 'image'
                    ? !!original?.outputAttachments?.some(
                        (entry: { key: string; index: number }) =>
                          entry.key === metadata.key && observationAttached(entry.index)
                      )
                    : undefined,
              })),
              outputRules: manifest,
            }
          : {}),
        adjustment:
          observedVersion?.presentationOnly && state.previousObservationSource !== state.observation
            ? {
                origin: 'context-maintenance',
                reason: observedVersion.reason,
                parentRef: observedVersion.parentRef,
                sourceRef: observedVersion.sourceRef,
                executed: false,
              }
            : undefined,
        read: {
          module: 'velaros:system',
          export: 'memory',
          operation: 'read',
          input: { ref: observation?.id },
        },
        collectedSourceRef: toNullable(current?.record.sources[0]?.id),
        presentationSourceRef: toNullable(state.observation),
      },
      results,
      materialStatus: {
        unit: 'utf16',
        footprint: {
          userInputs: view.goals.reduce((sum, item) => sum + item.text.length, 0),
          observeSource: sourceText.length,
          observeOutput: resultText.length,
          leasedResults: results.reduce(
            (sum, item) => sum + item.text.length + item.source.length,
            0
          ),
          leasedResultSources: results.reduce((sum, item) => sum + item.size.chars, 0),
        },
        largest: results
          .toSorted((a, b) => b.size.chars - a.size.chars)
          .slice(0, 8)
          .map((item) => ({
            ref: item.ref,
            size: item.size,
            representation: item.representation,
            bodyIncluded: item.bodyIncluded,
            remainingTurns: item.remainingTurns,
          })),
        changes: {
          added: currentRefs.filter((ref) => !previousRefs.includes(ref)),
          exited: previousRefs.filter((ref) => !currentRefs.includes(ref)),
          referenceOnly: results.filter((item) => !item.bodyIncluded).map((item) => item.ref),
        },
        omittedLeaseCount: allVisible.length - visible.length,
        imagesOmitted: imageReferences.some((item) => !item.attached),
        imageReferences: imageReferences.slice(0, 32),
        omittedImageReferences: Math.max(0, imageReferences.length - 32),
        observationAction: {
          sourceRef: toNullable(state.observation),
          adjust:
            '修改持续观察代码，控制字段、范围、数量及聚合；采集状态与原采集时间见 observation.freshness 和 observedAt，需要当前状态时用 refresh:true',
        },
      },
    })
    await this.update(
      (current) => ({
        ...current,
        pendingFrame: frameId,
        pendingObservationSource: state.observation,
        pendingOutputPresentation: outputPresentation,
        pendingObservation: observation?.id,
        pendingVisible: currentRefs,
        pendingDelivered: visible
          .filter((item) =>
            results.some(
              (result) => result.ref === item.ref && (result.bodyIncluded || result.bodyInHistory)
            )
          )
          .map((item) => ({ ref: item.ref, leaseId: item.leaseId ?? item.ref })),
      }),
      [],
      signal
    )
    return {
      body,
      outputCoverage,
      budget: { maxChars, resultBudgetChars, excerptChars, visibleResults: visible.length },
      images,
      prompt: '',
      squeezed: allVisible
        .filter((item) => !visible.some((current) => current.ref === item.ref))
        .map((item) => item.ref),
    }
  }

  public async delivered(
    frameId: string,
    refs: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    await this.update(
      (state) => {
        if (state.pendingFrame !== frameId) throw new AppError('CONFLICT', '材料确认帧已失效')
        return {
          ...state,
          pendingDelivered: state.pendingDelivered?.filter((item) => refs.includes(item.ref)),
        }
      },
      [],
      signal
    )
  }

  public async consume(frameId: string, signal: AbortSignal): Promise<void> {
    await this.update(
      (state) => {
        if (!state.pendingFrame) return state
        if (state.pendingFrame !== frameId) throw new AppError('CONFLICT', '租约回合身份已经失效')
        const completedTurns = state.completedTurns + 1
        const leases = state.leases
          .map((item) => ({
            ...item,
            expiresAfter:
              item.expiresAfter +
              (state.pendingDelivered?.some(
                (sent) => sent.ref === item.ref && sent.leaseId === (item.leaseId ?? item.ref)
              )
                ? 0
                : 1),
          }))
          .filter((item) => item.task || item.segment || item.expiresAfter > completedTurns)
        const jobs = (state.jobs ?? []).filter(
          (job) =>
            ['queued', 'running', 'unknown'].includes(job.status) ||
            leases.some((lease) => lease.executionId === job.executionId)
        )
        return {
          ...state,
          previousObservationSource: state.pendingObservationSource,
          pendingObservationSource: undefined,
          previousOutputPresentation: state.pendingOutputPresentation,
          pendingOutputPresentation: undefined,
          previousVisible: state.pendingVisible,
          pendingVisible: undefined,
          pendingFrame: undefined,
          previousObservation: state.pendingObservation,
          pendingObservation: undefined,
          completedTurns,
          pendingDelivered: undefined,
          jobs,
          leases,
        }
      },
      [],
      signal
    )
  }
}
