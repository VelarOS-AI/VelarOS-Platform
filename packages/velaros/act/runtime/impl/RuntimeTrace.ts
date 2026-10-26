import type {
  ContextInvocationJournalApi,
  ContextRecord,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import {
  isNull,
  isPlainObject,
  isString,
  isUndefined,
  Log,
  toNullable,
  toOptional,
} from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ModelToolBinding } from '../types/model-tools.js'
import type { ScriptControlReceipt } from '../types/runtime.js'
import type { ScriptExecutionReceipt, ScriptSubmissionReceipt } from '../types/session.js'
import type {
  ActAgentSummary,
  ActExecutionSummary,
  ActObservationRegistration,
  ActObservationRun,
  ActSessionActivityEntry,
  ActSessionActivityPage,
  ActTracePage,
  ActTraceQuery,
  ActTraceRecord,
  ActTurnTrace,
  ActVerificationAttemptSummary,
  ActVerificationCostSummary,
  TraceChildPhase,
} from '../types/trace.js'
import {
  executionDuration,
  executionOutcome,
  executionProcessOutput,
} from '../utils/execution-outcome.js'
import {
  modelAccounting,
  summarizeVerificationAttempt,
  summarizeVerificationCosts,
} from '../utils/trace-accounting.js'
import {
  childAnswerText,
  summarizeInvocation,
  summarizeModelRequest,
} from '../utils/tracePresentation.js'
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
      activityAfter = 0,
      activityLimit = 8,
      maxChars = ActRuntimeTuning.frameChars,
      fullContent = false,
      sessionId = this.sessionId,
    } = input
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32 ||
      !Number.isSafeInteger(activityAfter) ||
      activityAfter < 0 ||
      !Number.isSafeInteger(activityLimit) ||
      activityLimit < 1 ||
      activityLimit > 32 ||
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
    let remaining = fullContent ? Number.POSITIVE_INFINITY : maxChars
    let cursor = after
    for (const request of requests.slice(0, limit)) {
      if (remaining < 1) break
      const value = await trace.readSnapshot(request.ref.id, remaining, snapshot, fullContent)
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
        (value.requestSummary?.messages.length ?? 0) +
        value.executions.reduce(
          (sum, item) => sum + item.source.length + (item.processOutput?.length ?? 0),
          0
        ) +
        (value.observation.registration?.source.length ?? 0) +
        (value.observation.run?.source.length ?? 0) +
        value.agents.reduce((sum, item) => sum + item.task.length + item.answer.length, 0)
    }
    const sessionActivity = await trace.activitySnapshot(
      snapshot,
      activityAfter,
      activityLimit,
      Math.max(0, remaining),
      fullContent
    )
    return {
      rootSessionId: this.sessionId,
      sessionId,
      branches: bindings.filter((item) => item.rootTaskId === root?.task?.id),
      turns,
      sessionActivity,
      accounting: {
        modelRequests: {
          known: turns.filter((turn) => turn.modelAccounting.usage.coverage === 'known').length,
          unknown: turns.filter((turn) => turn.modelAccounting.usage.coverage === 'unknown').length,
          inflight: turns.filter((turn) => turn.modelAccounting.usage.coverage === 'inflight')
            .length,
        },
        verificationScope: 'session',
        verificationCost: await this.verificationCost(snapshot),
      },
      nextAfter: requests.some((record) => record.sequence > cursor) ? cursor : null,
      snapshotVersion: toNullable(snapshot?.version),
    }
  }

  private async activitySnapshot(
    snapshot: Nullable<ContextState>,
    after: number,
    limit: number,
    maxChars: number,
    fullContent: boolean
  ): Promise<ActSessionActivityPage> {
    const records = snapshot?.records ?? []
    const starts = records.filter(
      (record) => record.sequence > after && /^script:execution:[0-9a-f-]{36}$/u.test(record.title)
    )
    const entries: ActSessionActivityEntry[] = []
    let remaining = fullContent ? Number.POSITIVE_INFINITY : maxChars
    let cursor = after
    for (const start of starts.slice(0, limit)) {
      const executionId = start.title.slice('script:execution:'.length)
      const gaps: string[] = []
      const startBody = await this.storage.get(this.sessionId, start.objectId)
      let started: unknown
      try {
        started = isNull(startBody) ? undefined : JSON.parse(startBody)
      } catch (error) {
        this.log.debug('会话活动起始事实无法解释', {
          ref: start.ref,
          error: AppError.getMessage(error),
        })
      }
      const details =
        isPlainObject(started) && started.executionId === executionId ? started : undefined
      if (!details) gaps.push(`活动起始事实缺失或无效：${start.ref.id}`)
      const results = records.filter((record) => record.title === `script:${executionId}:result`)
      const activityRecords: ActTraceRecord[] = []
      for (const record of [start, ...results]) {
        const body =
          record === start ? startBody : await this.storage.get(this.sessionId, record.objectId)
        if (isNull(body)) gaps.push(`原文缺失：${record.ref.id}`)
        const text = isNull(body) ? null : body.slice(0, remaining)
        remaining -= text?.length ?? 0
        activityRecords.push({
          ref: record.ref,
          createdAt: record.createdAt,
          sequence: record.sequence,
          title: record.title,
          chars: record.chars,
          body: text,
          truncated: !isNull(body) && text!.length < body.length,
          sources: record.sources,
        })
      }
      if (isEmpty(results)) gaps.push(`活动尚无宿主结果：${executionId}`)
      const invocations: Array<ActTurnTrace['invocations'][number]> = []
      // 当前 journal 与目录快照分别读取；迟到事实保留在原 executionId，读取不会等待物理 IO。
      for (const invocation of await this.journal.list(this.sessionId, executionId)) {
        const summary = summarizeInvocation(invocation, remaining, fullContent)
        remaining -= summary.input.length + summary.output.length
        const body = JSON.stringify(invocation)
        const text = body.slice(0, remaining)
        remaining -= text.length
        invocations.push({
          id: invocation.prepared.id,
          executionId,
          chars: body.length,
          body: text,
          truncated: text.length < body.length,
          summary,
        })
      }
      entries.push({
        executionId,
        taskId: isString(details?.taskId) ? details.taskId : null,
        mode: details?.mode === 'execute' || details?.mode === 'observe' ? details.mode : null,
        kind: !details
          ? 'unknown'
          : details.kind === 'snapshot-capture'
            ? 'snapshot-capture'
            : 'script-execution',
        startedSequence: start.sequence,
        startRef: start.ref,
        resultRef: toNullable(results.at(-1)?.ref),
        records: activityRecords,
        invocations,
        gaps,
      })
      cursor = start.sequence
    }
    return {
      scope: 'session',
      sessionId: this.sessionId,
      entries,
      nextAfter: starts.some((record) => record.sequence > cursor) ? cursor : null,
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

  private async verificationCost(
    snapshot: Nullable<ContextState>
  ): Promise<ActVerificationCostSummary> {
    const attempts = new Map<string, Array<{ value: unknown; ref: ContextRecord['ref'] }>>()
    let incomplete = false
    for (const record of snapshot?.records ?? []) {
      if (!record.title.startsWith('task:verification:')) continue
      const identity = /^(task:verification:.+):(started|settled|late-result)$/u.exec(
        record.title
      )?.[1]
      const body = await this.storage.get(record.ref.sessionId, record.objectId)
      if (!identity || isNull(body)) {
        incomplete = true
        continue
      }
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch (error) {
        incomplete = true
        this.log.debug('核查总账事实正文无法解释', {
          ref: record.ref,
          error: AppError.getMessage(error),
        })
        continue
      }
      const events = attempts.get(identity) ?? []
      events.push({ value, ref: record.ref })
      attempts.set(identity, events)
    }
    const costs: ActVerificationCostSummary[] = []
    for (const events of attempts.values()) {
      const summary = summarizeVerificationAttempt(events)
      if (!summary || summary.records.length !== events.length) incomplete = true
      if (summary) costs.push(summary.cost)
    }
    return summarizeVerificationCosts(costs, incomplete)
  }

  private async readSnapshot(
    turnId: string,
    maxChars: number,
    snapshot: Nullable<ContextState>,
    fullContent = false
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
    // 没有响应不证明仍在请求；只有当前最后请求、活跃运行和未过期任务租约同时成立才记 inflight。
    const latestRequest = !records.some(
      (record) => record.title === 'model-request' && record.sequence > requestRecord.sequence
    )
    const stateRecord =
      !decision && latestRequest
        ? records.findLast((record) => record.title === 'act:state')
        : undefined
    const stateBody = stateRecord ? await raw(stateRecord) : null
    const activeRun: unknown = isNull(stateBody) ? undefined : JSON.parse(stateBody)
    const inflight =
      !decision &&
      latestRequest &&
      isPlainObject(activeRun) &&
      activeRun.id === request.runId &&
      activeRun.status === 'thinking' &&
      !!snapshot?.task?.lease &&
      snapshot.task.lease.expiresAt > Date.now() &&
      ['executing', 'context-pending', 'view-ready'].includes(snapshot.task.status)
    const accounting = modelAccounting(decoded, inflight)
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
    let observed: Optional<{
      sourceRef?: string
      resultRef?: string
      freshness?: ActObservationRun['collection']
    }>
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
      // 只关联实际请求选中的帧，容量试探产生的其他帧不代表本次展示预算。
      if (isString(saved.frameId))
        select(
          records.findLast(
            (record) =>
              record.title === `context:frame:${saved.frameId}` &&
              record.sequence < requestRecord.sequence
          )
        )
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
      const capture = frame.observation?.freshness?.snapshot
      if (isString(capture?.captureExecutionId)) {
        executions.add(capture.captureExecutionId)
        select(byRef(capture.captureResultRef))
        select(
          records.find(
            (record) => record.title === `script:execution:${capture.captureExecutionId}`
          )
        )
      }
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
            ['completed', 'cancelled', 'failed', 'context_blocked'].includes(event.status)
          )
            boundary = record.sequence + 1
        } else select(record)
      }
    for (const record of records)
      if (selected.has(record.ref.id)) {
        const match = /^script:([0-9a-f-]{36}):result$/u.exec(record.title)
        if (
          match &&
          !(
            record.ref.id === observed?.resultRef &&
            observed.freshness &&
            observed.freshness.status !== 'collected'
          )
        )
          executions.add(match[1]!)
      }
    for (const record of records)
      if ([...executions].some((id) => record.title === `script:${id}:result`)) select(record)
    // 核查 attempt 归最初 started 的请求窗口；迟到阶段始终回到原 attempt，不归到当前任务或当前请求。
    const verification: ActVerificationAttemptSummary[] = []
    const verificationStarts = records.filter(
      (record) =>
        record.title.startsWith('task:verification:') &&
        record.title.endsWith(':started') &&
        record.sequence > requestRecord.sequence &&
        record.sequence < boundary
    )
    for (const start of verificationStarts) {
      const prefix = start.title.slice(0, -'started'.length)
      const events: Array<{ record: ContextRecord; value: unknown }> = []
      for (const record of records.filter((item) => item.title.startsWith(prefix))) {
        const body = await raw(record)
        events.push({ record, value: isNull(body) ? undefined : JSON.parse(body) })
      }
      const summary = summarizeVerificationAttempt(
        events.map(({ record, value }) => ({ ref: record.ref, value }))
      )
      if (!summary) {
        gaps.push(`核查尝试无法解释：${start.ref.id}`)
        continue
      }
      verification.push(summary)
      for (const { record } of events) select(record)
    }
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
    const journal = new Map<string, Awaited<ReturnType<ContextInvocationJournalApi['list']>>>()
    for (const executionId of executions)
      journal.set(executionId, await this.journal.list(this.sessionId, executionId))
    let remaining = maxChars
    const agentTasks = new Map<object, string>()
    // 子任务的说明先占正文预算；大请求和日志不能把线程的身份说明挤成空字符串。
    for (const entries of journal.values())
      for (const invocation of entries) {
        const { binding, operation, input } = invocation.prepared
        if (binding.moduleId !== 'velaros:agents' || !['start', 'resume'].includes(operation))
          continue
        const task = isPlainObject(input) ? (operation === 'start' ? input.task : input.input) : ''
        const text = (isString(task) ? task : '').slice(
          0,
          Math.max(
            0,
            fullContent ? remaining : Math.min(remaining, ActRuntimeTuning.parentTaskPreviewChars)
          )
        )
        agentTasks.set(invocation, text)
        remaining -= text.length
      }
    const requestSummary = summarizeModelRequest(request, remaining, fullContent)
    remaining -= (requestSummary?.system.length ?? 0) + (requestSummary?.messages.length ?? 0)
    const project = async (record: ContextRecord): Promise<ActTraceRecord> => {
      const body = await raw(record)
      const text = isNull(body) ? null : body.slice(0, remaining)
      remaining -= text?.length ?? 0
      return {
        ref: record.ref,
        createdAt: record.createdAt,
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
    for (const executionId of executions)
      for (const invocation of journal.get(executionId)!) {
        const summary = summarizeInvocation(invocation, remaining, fullContent)
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
    ): Promise<Pick<ActExecutionSummary, 'source' | 'sourceTruncated' | 'language'>> => {
      const program = ref && recordById.get(ref) ? await raw(recordById.get(ref)!) : null
      let text: unknown = ''
      let language: 'node' | 'shell' = 'node'
      if (!isNull(program))
        try {
          const data = JSON.parse(program) as { source?: unknown; language?: unknown }
          text = data.source
          if (data.language === 'shell') language = 'shell'
        } catch (error) {
          this.log.debug('程序记录读不出源码', { ref, error: AppError.getMessage(error) })
          gaps.push(`程序记录读不出源码：${ref}`)
        }
      const full = isString(text) ? text : ''
      const source = full.slice(0, Math.max(0, remaining))
      remaining -= source.length
      return {
        source,
        sourceTruncated: source.length < full.length,
        language,
      }
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
      const processText = executionProcessOutput(persisted)
      const processOutput = processText?.slice(0, Math.max(0, Math.min(6000, remaining)))
      remaining -= processOutput?.length ?? 0
      summaries.push({
        executionId: item.executionId,
        position,
        ...outcome,
        durationMs: rejected ? null : executionDuration(persisted),
        ...(isUndefined(processText)
          ? {}
          : { processOutput, processOutputTruncated: processOutput!.length < processText.length }),
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
      const receipts =
        journal.get(observationId) ?? (await this.journal.list(this.sessionId, observationId))
      run = {
        collection: toOptional(observed?.freshness),
        executionId: observationId,
        ...executionOutcome(
          persisted,
          receipts.map((invocation) => invocation.receipt)
        ),
        durationMs: executionDuration(persisted),
        ...(await programSource(observed?.sourceRef)),
      }
    }
    // 本回合执行里派发或续跑的子任务：start、resume 的回执就是 job。同一个子任务可以续跑好几次，它的
    // 持久记录按段切开：派发或续跑写下的那份还没有 pending，是一段的开头，之后的提问、回答与收束都记在这一段。
    // 本回合第 k 次派发或续跑它，对应本回合请求之后它开始的第 k 段；状态、回答与耗时都只取那一段
    const phases = new Map<string, TraceChildPhase[]>()
    const childPhases = async (id: string) => {
      if (!phases.has(id)) {
        const list: TraceChildPhase[] = []
        for (const record of records) {
          if (record.title !== `act:child:${id}` || record.sequence < requestRecord.sequence)
            continue
          const body = await raw(record)
          if (isNull(body)) continue
          const job: Record<string, unknown> = JSON.parse(body)
          if (job.status === 'running' && !('pending' in job))
            list.push({ first: record, last: record, job })
          else if (!isEmpty(list)) list[list.length - 1] = { ...list.at(-1)!, last: record, job }
        }
        phases.set(id, list)
      }
      return phases.get(id)!
    }
    const claimed = new Map<string, number>()
    const agents: ActAgentSummary[] = []
    for (const item of dispatched) {
      if (!item.executionId) continue
      for (const invocation of journal.get(item.executionId) ?? []) {
        const { binding, operation } = invocation.prepared
        const job: unknown = invocation.receipt?.value
        if (
          binding.moduleId !== 'velaros:agents' ||
          !['start', 'resume'].includes(operation) ||
          !isPlainObject(job) ||
          !isString(job.id) ||
          !isString(job.sessionId) ||
          !isString(job.profile)
        )
          continue
        const index = claimed.get(job.id) ?? 0
        claimed.set(job.id, index + 1)
        const phase = (await childPhases(job.id))[index]
        const latest = phase?.job ?? job
        const taskText = agentTasks.get(invocation) ?? ''
        const resultId =
          isPlainObject(latest.result) && isString(latest.result.id) ? latest.result.id : ''
        const resultRecord = recordById.get(resultId)
        const note = resultRecord ? await raw(resultRecord) : null
        const answer = isNull(note) ? '' : childAnswerText(JSON.parse(note))
        const answerText = answer.slice(0, Math.max(0, remaining))
        remaining -= answerText.length
        const status = (
          isString(latest.status) ? latest.status : 'running'
        ) as ActAgentSummary['status']
        const settled = !['running', 'waiting'].includes(status)
        const startedAt = Date.parse(phase?.first.createdAt ?? '')
        const settledAt = Date.parse((resultRecord ?? phase?.last)?.createdAt ?? '')
        agents.push({
          id: job.id,
          sessionId: job.sessionId,
          executionId: item.executionId,
          profile: isString(latest.profile) ? latest.profile : job.profile,
          task: taskText,
          status,
          error: isString(latest.error) ? latest.error : null,
          answer: answerText,
          answerTruncated: answerText.length < answer.length,
          durationMs:
            settled && Number.isFinite(startedAt) && Number.isFinite(settledAt)
              ? Math.max(0, settledAt - startedAt)
              : null,
        })
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
      modelAccounting: accounting,
      verification: {
        attempts: verification,
        cost: summarizeVerificationCosts(verification.map((attempt) => attempt.cost)),
      },
      request: requestTrace,
      requestSummary,
      response: responseTrace,
      decision: decisionTrace,
      records: traceRecords,
      executions: summaries,
      observation: { registration, run },
      agents,
      invocations,
      nextTurnId: toNullable(next?.ref.id),
      snapshotVersion: snapshot!.version,
      gaps: [...new Set(gaps)],
    }
  }
}
