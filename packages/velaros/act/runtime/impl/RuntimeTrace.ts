import type {
  ContextInvocationJournalApi,
  ContextRecord,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import { isNull, isString, isUndefined, Log, toNullable } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ModelToolBinding } from '../types/model-tools.js'
import type { ScriptControlReceipt } from '../types/runtime.js'
import type { ScriptExecutionReceipt, ScriptSubmissionReceipt } from '../types/session.js'
import type {
  ActExecutionSummary,
  ActObservationRegistration,
  ActObservationRun,
  ActTracePage,
  ActTraceQuery,
  ActTraceRecord,
  ActTurnTrace,
} from '../types/trace.js'
import { executionDuration, executionOutcome } from '../utils/execution-outcome.js'
import { summarizeInvocation, summarizeModelRequest } from '../utils/tracePresentation.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

/** 只读连接既有记录，不执行代码或生成事实正文。 */
export interface RuntimeTraceApi {
  /** 按持久归属读取根会话或已关闭支线。 */
  page(input?: ActTraceQuery): Promise<ActTracePage>
  /** 在当前会话内解析模型回合，并按总预算读取证据。 */
  read(turnId: string, maxChars?: number): Promise<ActTurnTrace>
}

/** 从唯一存储及 Kernel 日志连接证据，缺失记录不推断成执行成功。 */
export class RuntimeTrace implements RuntimeTraceApi {
  private readonly log = Log.tag('RuntimeTrace')

  public constructor(
    private readonly sessionId: string,
    private readonly storage: ContextStorage,
    private readonly journal: ContextInvocationJournalApi
  ) {}

  public async page(input: ActTraceQuery = {}): Promise<ActTracePage> {
    const {
      after = 0,
      limit = 8,
      maxChars = ActRuntimeTuning.frameChars,
      sessionId = this.sessionId,
    } = input
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32 ||
      !Number.isSafeInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > 8_000_000
    )
      throw new AppError('VALIDATION', '追踪分页或正文预算无效')
    const root = await this.storage.load(this.sessionId)
    const nodes = [
      ...new Map(
        (root?.records ?? [])
          .filter((record) => record.title.startsWith('model-tool:node:'))
          .map((record) => [record.title, record])
      ).values(),
    ]
    const bindings: ModelToolBinding[] = []
    for (const record of nodes) {
      const body = await this.storage.get(this.sessionId, record.objectId)
      if (isNull(body)) throw new AppError('NOT_FOUND', '模型工具归属记录原文缺失')
      bindings.push(JSON.parse(body))
    }
    if (
      sessionId !== this.sessionId &&
      !bindings.some(
        (item) => item.sessionId === sessionId && item.rootSessionId === this.sessionId
      )
    )
      throw new AppError('PERMISSION', '支线不属于指定根会话')
    const snapshot = sessionId === this.sessionId ? root : await this.storage.load(sessionId)
    const requests = (snapshot?.records ?? []).filter(
      (record) => record.title === 'model-request' && record.sequence > after
    )
    const trace = new RuntimeTrace(sessionId, this.storage, this.journal)
    const turns: ActTurnTrace[] = []
    let remaining = maxChars
    let cursor = after
    for (const request of requests.slice(0, limit)) {
      if (remaining < 1) break
      const value = await trace.readSnapshot(request.ref.id, remaining, snapshot)
      turns.push(value)
      cursor = request.sequence
      remaining -=
        [
          value.request,
          value.response,
          value.decision,
          ...value.records,
          ...value.invocations,
        ].reduce((sum, item) => sum + (item?.body?.length ?? 0), 0) +
        value.invocations.reduce(
          (sum, item) => sum + item.summary.input.length + item.summary.output.length,
          0
        ) +
        (value.requestSummary?.system.length ?? 0) +
        (value.requestSummary?.messages.length ?? 0)
    }
    return {
      rootSessionId: this.sessionId,
      sessionId,
      branches: bindings.filter((item) => item.rootTaskId === root?.task?.id),
      turns,
      nextAfter: requests.some((record) => record.sequence > cursor) ? cursor : null,
      snapshotVersion: toNullable(snapshot?.version),
    }
  }

  public async read(
    turnId: string,
    maxChars: number = ActRuntimeTuning.frameChars
  ): Promise<ActTurnTrace> {
    if (!turnId || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8_000_000)
      throw new AppError('VALIDATION', '回合身份或追踪正文预算无效')
    const snapshot = await this.storage.load(this.sessionId)
    return this.readSnapshot(turnId, maxChars, snapshot)
  }

  private async readSnapshot(
    turnId: string,
    maxChars: number,
    snapshot: Nullable<ContextState>
  ): Promise<ActTurnTrace> {
    const records = snapshot?.records ?? []
    const recordById = new Map(records.map((record) => [record.ref.id, record]))
    const requestRecord = records.find(
      (record) => record.ref.id === turnId && record.title === 'model-request'
    )
    if (!requestRecord) throw new AppError('NOT_FOUND', '当前会话没有这个模型回合')
    const cache = new Map<string, Nullable<string>>()
    const gaps: string[] = []
    const raw = async (record: ContextRecord): Promise<Nullable<string>> => {
      if (!cache.has(record.ref.id)) {
        const body = await this.storage.get(this.sessionId, record.objectId)
        cache.set(record.ref.id, body)
        if (isNull(body)) gaps.push(`原文缺失：${record.ref.id}`)
      }
      return cache.get(record.ref.id)!
    }
    const requestBody = await raw(requestRecord)
    if (isNull(requestBody)) throw new AppError('NOT_FOUND', '模型请求原文缺失，不能重建回合身份')
    const request = JSON.parse(requestBody)
    let next: Optional<ContextRecord>
    let boundary =
      records.find(
        (record) => record.sequence > requestRecord.sequence && record.title === 'model-request'
      )?.sequence ?? Infinity
    for (const record of records)
      if (record.sequence > requestRecord.sequence && record.title === 'model-request') {
        const body = await raw(record)
        if (!isNull(body) && JSON.parse(body).runId === request.runId) {
          next = record
          break
        }
      }
    const linked = (record: ContextRecord) =>
      record.sources.some((ref) => ref.sessionId === this.sessionId && ref.id === turnId)
    const decision = records.findLast(
      (record) => record.title === 'model-response' && linked(record)
    )
    const decisionBody = decision ? await raw(decision) : null
    const decoded = isNull(decisionBody) ? undefined : JSON.parse(decisionBody)
    const response =
      decoded?.rawRef?.sessionId === this.sessionId
        ? records.find((record) => record.ref.id === decoded.rawRef.id)
        : records.findLast((record) => record.kind === 'assistant' && linked(record))
    if (!decision) gaps.push('本次请求尚无持久化协议判定')
    if (!response) gaps.push('本次请求尚无持久化模型原文')
    const selected = new Set<string>()
    const executions = new Set<string>()
    // 本回合响应派发的一次性执行，按声明顺序；取每次派发的最后一份控制回执
    const dispatched: Array<ScriptControlReceipt | ScriptExecutionReceipt> = []
    // 本回合响应登记的观察，同样取最后一份控制回执
    let registered: Optional<ScriptControlReceipt>
    // 喂进本回合请求的那次观察运行
    let observed: Optional<{ sourceRef?: string; resultRef?: string }>
    const select = (record: Optional<ContextRecord>) => {
      if (record) selected.add(record.ref.id)
    }
    const byRef = (id: Optional<string>) => {
      const record = id ? recordById.get(id) : undefined
      if (id && !record) gaps.push(`引用记录缺失：${id}`)
      return record
    }
    const dispatches = records.filter(
      (record) => record.title === 'script:dispatch' && linked(record)
    )
    if (
      decoded?.status === 'accepted' &&
      !isUndefined(decoded.decoded?.submission) &&
      isEmpty(dispatches)
    )
      gaps.push('协议已接受，尚无脚本派发记录')
    for (const dispatch of dispatches) {
      select(dispatch)
      const body = await raw(dispatch)
      if (isNull(body)) continue
      const { controlId } = JSON.parse(body)
      const receipts = records.filter((record) => record.title === `script:control:${controlId}`)
      if (isEmpty(receipts)) gaps.push(`派发尚无控制回执：${controlId}`)
      for (const [index, record] of receipts.entries()) {
        select(record)
        const saved = await raw(record)
        if (isNull(saved)) continue
        const receipt = JSON.parse(saved).receipt as ScriptSubmissionReceipt
        if (index === receipts.length - 1) {
          dispatched.push(...(receipt.executions ?? (receipt.execute ? [receipt.execute] : [])))
          if (receipt.observe) registered = receipt.observe
        }
        for (const item of [receipt.observe, receipt.execute, ...(receipt.executions ?? [])])
          if (item) {
            select(byRef(item.sourceRef))
            select(byRef(item.parentRef))
            select(byRef('draftRef' in item ? item.draftRef : undefined))
            if (item.executionId) executions.add(item.executionId)
            select(byRef(item.resultRef))
          }
      }
    }
    const material = request.request?.materials?.findLast(
      (item: { origin: string }) => item.origin === 'runtime-view'
    )
    if (material) {
      const saved = JSON.parse(material.text)
      const frame = saved.partitions
        ? {
            goals: saved.partitions.task.goals,
            observation: saved.partitions.observation,
            results: saved.partitions.recent.results,
          }
        : saved
      for (const goal of frame.goals ?? []) select(byRef(goal.record?.ref?.id))
      observed = frame.observation
      select(byRef(frame.observation?.sourceRef))
      select(byRef(frame.observation?.resultRef))
      for (const result of frame.results ?? []) {
        select(byRef(result.ref))
        select(byRef(result.sourceRef))
      }
    }
    // 记录发送前的租约与本次接收到下一请求之间的变化，不把当前最新状态冒充历史帧。
    select(
      records.findLast(
        (record) =>
          record.title === 'script:lease-state' && record.sequence < requestRecord.sequence
      )
    )
    for (const record of records)
      if (
        record.sequence > requestRecord.sequence &&
        record.sequence < boundary &&
        ['script:lease-state', 'act:event', 'act:state'].includes(record.title)
      ) {
        if (record.title === 'act:event' || record.title === 'act:state') {
          const body = await raw(record)
          if (isNull(body)) continue
          const event = JSON.parse(body)
          if ((event.runId ?? event.id) !== request.runId) continue
          select(record)
          if (
            event.type === 'state' &&
            ['completed', 'cancelled', 'failed', 'context_blocked', 'needs_reconcile'].includes(
              event.status
            )
          )
            boundary = record.sequence + 1
        } else select(record)
      }
    for (const record of records)
      if (selected.has(record.ref.id)) {
        const match = /^script:([0-9a-f-]{36}):result$/u.exec(record.title)
        if (match) executions.add(match[1]!)
      }
    for (const record of records)
      if ([...executions].some((id) => record.title === `script:${id}:result`)) select(record)
    // 结果的来源链包含真实源码、图片和版本；仅在当前会话内解析。
    for (const id of selected)
      for (const ref of recordById.get(id)!.sources)
        if (ref.sessionId === this.sessionId) select(byRef(ref.id))
    for (const record of records)
      if (
        record.title.startsWith('script:version:') &&
        selected.has(record.title.slice('script:version:'.length))
      )
        select(record)
    let remaining = maxChars
    const requestSummary = summarizeModelRequest(request, remaining)
    remaining -= (requestSummary?.system.length ?? 0) + (requestSummary?.messages.length ?? 0)
    const project = async (record: ContextRecord): Promise<ActTraceRecord> => {
      const body = await raw(record)
      const text = isNull(body) ? null : body.slice(0, remaining)
      remaining -= text?.length ?? 0
      return {
        ref: record.ref,
        sequence: record.sequence,
        title: record.title,
        chars: record.chars,
        body: text,
        truncated: !isNull(body) && text!.length < body.length,
        sources: record.sources,
      }
    }
    const requestTrace = await project(requestRecord)
    const responseTrace = response ? await project(response) : null
    const decisionTrace = decision ? await project(decision) : null
    selected.delete(requestRecord.ref.id)
    if (response) selected.delete(response.ref.id)
    if (decision) selected.delete(decision.ref.id)
    const traceRecords: ActTraceRecord[] = []
    for (const record of records)
      if (selected.has(record.ref.id)) traceRecords.push(await project(record))
    const invocations: Array<ActTurnTrace['invocations'][number]> = []
    const journal = new Map<string, Awaited<ReturnType<ContextInvocationJournalApi['list']>>>()
    for (const executionId of executions)
      journal.set(executionId, await this.journal.list(this.sessionId, executionId))
    for (const executionId of executions)
      for (const invocation of journal.get(executionId)!) {
        const summary = summarizeInvocation(invocation, remaining)
        remaining -= summary.input.length + summary.output.length
        const rawBody = JSON.stringify(invocation)
        const body = rawBody.slice(0, remaining)
        remaining -= body.length
        invocations.push({
          id: invocation.prepared.id,
          executionId: invocation.prepared.executionId,
          chars: rawBody.length,
          body,
          truncated: body.length < rawBody.length,
          summary,
        })
      }
    // 程序记录里的源码，按本页剩下的正文预算截取；记录读不出源码时记一处缺口，不让整页读取失败
    const programSource = async (
      ref: Optional<string>
    ): Promise<Pick<ActExecutionSummary, 'source' | 'sourceTruncated'>> => {
      const program = ref && recordById.get(ref) ? await raw(recordById.get(ref)!) : null
      let text: unknown = ''
      if (!isNull(program))
        try {
          text = (JSON.parse(program) as { source?: unknown }).source
        } catch (error) {
          this.log.debug('程序记录读不出源码', { ref, error: AppError.getMessage(error) })
          gaps.push(`程序记录读不出源码：${ref}`)
        }
      const full = isString(text) ? text : ''
      const source = full.slice(0, Math.max(0, remaining))
      remaining -= source.length
      return { source, sourceTruncated: source.length < full.length }
    }
    const summaries: ActExecutionSummary[] = []
    for (const [position, item] of dispatched.entries()) {
      if (!item.executionId) continue
      const result = records.findLast(
        (record) => record.title === `script:${item.executionId}:result`
      )
      const saved = result ? await raw(result) : null
      const persisted: unknown = isNull(saved) ? undefined : JSON.parse(saved)
      // 没过检查的执行没有运行结果，控制回执本身就是它的结局
      const rejected = 'status' in item && item.status === 'rejected'
      const outcome = executionOutcome(
        rejected ? item : persisted,
        (journal.get(item.executionId) ?? []).map((invocation) => invocation.receipt)
      )
      const ref = item.sourceRef ?? ('draftRef' in item ? item.draftRef : undefined)
      summaries.push({
        executionId: item.executionId,
        position,
        ...outcome,
        durationMs: rejected ? null : executionDuration(persisted),
        ...(await programSource(ref)),
      })
    }
    let registration: Nullable<ActObservationRegistration> = null
    if (registered && ['updated', 'unchanged', 'cleared', 'rejected'].includes(registered.status)) {
      const status = registered.status as ActObservationRegistration['status']
      registration = {
        status,
        // 没登记上的控制回执带着诊断，与没过检查的执行同一套原因
        failure: status === 'rejected' ? executionOutcome(registered, []).failure : null,
        ...(status === 'cleared'
          ? { source: '', sourceTruncated: false }
          : await programSource(registered.sourceRef ?? registered.draftRef)),
      }
    }
    let run: Nullable<ActObservationRun> = null
    const observation = observed?.resultRef ? recordById.get(observed.resultRef) : undefined
    const observationId = observation
      ? /^script:([0-9a-f-]{36}):result$/u.exec(observation.title)?.[1]
      : undefined
    if (observation && observationId) {
      const saved = await raw(observation)
      const persisted: unknown = isNull(saved) ? undefined : JSON.parse(saved)
      run = {
        executionId: observationId,
        ...executionOutcome(
          persisted,
          (journal.get(observationId) ?? []).map((invocation) => invocation.receipt)
        ),
        durationMs: executionDuration(persisted),
        ...(await programSource(observed?.sourceRef)),
      }
    }
    return {
      sessionId: this.sessionId,
      turnId,
      runId: request.runId,
      turn: request.turn,
      repair: request.repair,
      timing: {
        observationMs: toNullable(request.preparation?.observationMs),
        contextMs: toNullable(request.preparation?.contextMs),
        modelMs: toNullable(decoded?.timing?.modelMs),
        firstTextMs: toNullable(decoded?.timing?.firstTextMs),
      },
      request: requestTrace,
      requestSummary,
      response: responseTrace,
      decision: decisionTrace,
      records: traceRecords,
      executions: summaries,
      observation: { registration, run },
      invocations,
      nextTurnId: toNullable(next?.ref.id),
      snapshotVersion: snapshot!.version,
      gaps: [...new Set(gaps)],
    }
  }
}
