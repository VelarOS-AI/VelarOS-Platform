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
import { ContextLimits } from '@velaros-ai/context'
import { isFalse, isNull, toNullable } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelImage } from '@velaros-ai/kernel'
import {
  type CodeProgramRequest,
  type ScriptOutputCapture,
  type ScriptOutputEdit,
  scriptOutputs,
  type ScriptOutputSummary,
} from '@velaros-ai/script'

import { ScriptLeaseLimits } from '../../system/contract/constants.js'
import type { ResultReleased, ResultRetained } from '../../system/types/memory.js'
import type { PreparedScript } from '../types/program.js'
import type { ScriptRetention } from '../types/results.js'
import type {
  ProgramLeaseState,
  ScriptControlIdentity,
  ScriptJob,
  ScriptProgramVersion,
} from '../types/runtime.js'
import type { ScriptSubmissionReceipt } from '../types/session.js'
import { executionMaterial, projectMaterial } from '../utils/materials.js'
import {
  programContentChange,
  programContentText,
  programFailure,
} from '../utils/program-context.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

/** 与 ContextStorage 共用记录的脚本上下文及可见租约。 */
export interface ProgramContextApi {
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
    maxChars?: number
  ): Promise<{
    body: string
    images: readonly ModelImage[]
    prompt: string
    /** 租约有效、但因本帧容量放不下而没有列出的结果。 */
    squeezed: readonly string[]
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
  public constructor(
    private readonly sessionId: string,
    private readonly context: ContextRuntime,
    private readonly storage: ContextStorage
  ) {}

  public async observeHealth(
    sourceRef: string,
    resultRef: string,
    success: boolean,
    uncertain: boolean
  ): Promise<void> {
    await this.update((state) => {
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
      await this.snapshot([{ title: 'script:lease-state', kind: 'audit', latest: true }])
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

  private async readState(snapshot: Nullable<ContextRecordSnapshot>): Promise<ProgramLeaseState> {
    const record = snapshot?.records.findLast(
      (item) => item.kind === 'audit' && item.title === 'script:lease-state'
    )
    if (!record || record.sequence <= (snapshot?.metadata.task?.startedSequence ?? 0))
      return { completedTurns: 0, leases: [] }
    const body = await this.storage.get(this.sessionId, record.objectId)
    if (isNull(body)) throw new AppError('NOT_FOUND', '程序租约记录缺失')
    return JSON.parse(body) as ProgramLeaseState
  }

  private async update(
    change: (state: ProgramLeaseState) => ProgramLeaseState,
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
          ...refs.map((refId) => ({ refId })),
        ],
        true
      )) ?? {
        metadata: { version: 0, workingSet: { revision: 0, cursor: 0, items: [] } },
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
      const changed = change(previous)
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
    id: string = crypto.randomUUID(),
    sources: readonly ContextRef[] = []
  ): Promise<ContextRecord> {
    if (body.length > ContextLimits.objectChars)
      throw new AppError('TOO_LARGE', '程序记录超过上下文对象限制')
    const objectId = await this.storage.put(this.sessionId, body)
    return {
      ref: { sessionId: this.sessionId, id },
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
        (state) => {
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
                  health:
                    prepared.some(
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
    const next = crypto.randomUUID()
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
          expiresAfter:
            typeof turns === 'number' ? state.completedTurns + turns : state.completedTurns,
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
    if (result.record.kind !== 'audit' || !/^script:[0-9a-f-]{36}$/u.test(result.record.title))
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
      !/^script:[0-9a-f-]{36}:result$/u.test(result.record.title)
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
      (state) => ({ ...state, leases: state.leases.filter((item) => item.ref !== ref) }),
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
    }))
  }

  public async project(
    view: ModelView,
    observation: Optional<ContextRef>,
    observationImages: readonly ModelImage[],
    signal: AbortSignal,
    maxChars: number = ActRuntimeTuning.frameChars
  ): Promise<{
    body: string
    images: readonly ModelImage[]
    prompt: string
    squeezed: readonly string[]
  }> {
    const selected = await this.snapshot([
      { title: 'script:lease-state', kind: 'audit', latest: true },
      { title: 'search:history-reset', latest: true },
      { title: 'script:output-summaries', latest: true },
      { title: 'user:image' },
      { titlePrefix: 'act:child:' },
    ])
    const state = await this.readState(selected)
    const snapshot = selected ? { ...selected.metadata, records: selected.records } : null
    const frameId = crypto.randomUUID()
    const allVisible = state.leases.filter(
      (item) => item.task || item.segment || item.expiresAfter > state.completedTurns
    )
    const visible = allVisible.slice(-Math.max(1, Math.min(64, Math.floor(maxChars / 768))))
    const excerptChars = Math.max(
      1,
      Math.min(ScriptLeaseLimits.resultChars, Math.floor(maxChars / (visible.length + 4) / 2))
    )
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
    const leaseMissing: Array<{ key: string; ref: string; reason: string }> = []
    for (const lease of allVisible.filter(
      (item) => !visible.some((current) => current.ref === item.ref)
    )) {
      const result = await this.read(lease.ref, 0, 1)
      const archived = JSON.parse((await this.storage.get(this.sessionId, result.record.objectId))!)
      for (const block of archived.output?.blocks ?? [])
        if (block.options.required)
          leaseMissing.push({
            key: block.key,
            ref: lease.ref,
            reason: 'required-lease-not-delivered',
          })
    }
    const results: Array<
      ReturnType<typeof projectMaterial> & {
        ref: string
        sourceRef: string
        source: string
        sourceTruncated: boolean
        structuredOutput?: boolean
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
      failure: NonNullable<ReturnType<typeof programFailure>>
    }>
    for (const lease of visible) {
      signal.throwIfAborted()
      const result = await this.read(lease.ref, 0, excerptChars)
      const source = await this.context.read(
        { sessionId: this.sessionId, id: lease.sourceRef },
        { limit: ActRuntimeTuning.readChars }
      )
      const sourceText = programContentText(source, true)
      const full = await this.storage.get(this.sessionId, result.record.objectId)
      if (isNull(full)) throw new AppError('NOT_FOUND', '结果归档正文缺失')
      const archived = JSON.parse(full)
      const failure = programFailure(archived)
      feedback = failure ? { ref: lease.ref, sourceRef: lease.sourceRef, failure } : undefined
      const output = archived.output as Optional<ScriptOutputCapture>
      const managed =
        output &&
        (Object.keys(output.config).length ||
          output.blocks.some((block) => Object.keys(block.options).length))
      const display = managed
        ? scriptOutputs.project(output, lease.ref, excerptChars, undefined, summaries, taskRevision)
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
        : projectMaterial(executionMaterial(archived), result.record.ref, excerptChars)
      for (const block of output?.blocks ?? [])
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
            })
        }
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
          taskRevision
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
          adjust: '修改持续观察代码，控制字段、范围、数量及聚合；观察输出来自本轮真实执行',
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
            results.some((result) => result.ref === item.ref && result.bodyIncluded)
          )
          .map((item) => ({ ref: item.ref, leaseId: item.leaseId ?? item.ref })),
      }),
      [],
      signal
    )
    return {
      body,
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
