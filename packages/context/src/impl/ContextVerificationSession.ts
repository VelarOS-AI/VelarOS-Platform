import { Log } from '@velaros-ai/core'
import { createTimeoutError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { ContextVerificationLimits } from '../contract/constants.js'
import type {
  ContextVerificationContext,
  ContextVerificationExecution,
  ContextVerificationSpec,
  ContextViewOptions,
} from '../contract/requires.js'
import type {
  ContextCompletionApplicability,
  ContextCompletionBinding,
  ContextCompletionRecord,
  ContextRef,
  ContextVerificationAttempt,
  ContextVerificationCheck,
  ContextVerificationCost,
  ContextVerificationFingerprint,
} from '../types/context.js'
import { contextFailure } from '../utils/state.js'
import {
  checkVerificationCost,
  checkVerificationSpec,
  mergeVerificationCosts,
  verificationExecutionCheck,
  verificationFingerprint,
  verificationSpecKey,
} from '../utils/verification.js'
import { awaitContextOperation } from '../utils/view.js'

/** 单个 ContextView 生命周期内的可信核查复用；不可变尝试账与业务完成分别发布。 */
export interface ContextVerificationSessionApi {
  /** 绑定当前任务和宿主对象，给领域核查器提供可选逐项 helper。 */
  open(
    taskId: string,
    binding: Optional<ContextCompletionBinding>,
    signal: AbortSignal
  ): Promise<ContextVerificationContext>
  /** 对历史报告逐项重新探测；没有本生命周期内可信注册时保持未知。 */
  applicability(
    ref: ContextRef,
    record: ContextCompletionRecord,
    signal: AbortSignal
  ): Promise<ContextCompletionApplicability>
}

/** 缓存只在此实例内有效，重新打开 ContextView 后历史证明仍可读但必须实际检查。 */
export class ContextVerificationSession implements ContextVerificationSessionApi {
  private readonly proofs = new Map<
    string,
    {
      boundary: string
      spec: ContextVerificationSpec
      fingerprint: string
      check: ContextVerificationCheck
    }
  >()
  private readonly probes = new Map<string, Promise<ContextVerificationFingerprint>>()
  private readonly current = new Map<string, ContextVerificationSpec>()
  private readonly history = new Map<
    string,
    {
      boundary: string
      spec: ContextVerificationSpec
      fingerprint: string
      check: ContextVerificationCheck
    }
  >()

  public constructor(private readonly options: ContextViewOptions) {}

  private async boundary(): Promise<string> {
    const { storage, sessionId } = this.options
    const selected = storage.selectSnapshot
      ? await storage.selectSnapshot(sessionId, [{ title: 'search:history-reset', latest: true }])
      : undefined
    const state = storage.selectSnapshot
      ? selected && { ...selected.metadata, records: selected.records }
      : await storage.load(sessionId)
    if (!state?.task?.id || ['cancelled', 'failed'].includes(state.task.status))
      throw contextFailure('CANCELLED', '核查所属任务已结束或不存在')
    return JSON.stringify([
      sessionId,
      state.task.id,
      state.task.startedSequence ?? 0,
      state.records.filter((record) => record.title === 'search:history-reset').at(-1)?.sequence ??
        0,
    ])
  }

  private async probe(
    spec: ContextVerificationSpec,
    signal: AbortSignal,
    late?: (value: ContextVerificationFingerprint, durationMs: number) => Promise<void>
  ): Promise<ContextVerificationFingerprint> {
    signal.throwIfAborted()
    const probeKey = verificationSpecKey(spec)
    if (this.probes.has(probeKey) || this.probes.size >= ContextVerificationLimits.cachedChecks)
      return { status: 'unknown', cost: { coverage: 'complete', charges: [] } }
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const timers = new TimerScope({ name: 'ContextVerificationSession.probe' })
    timers.after(ContextVerificationLimits.probeMs, () =>
      controller.abort(createTimeoutError('领域核查探测超时'))
    )
    const pending = Promise.resolve()
      .then(() => spec.probe(combined))
      .then((value) => structuredClone(value))
    const started = performance.now()
    let abandoned = false
    this.probes.set(probeKey, pending)
    const release = () => {
      if (this.probes.get(probeKey) === pending) this.probes.delete(probeKey)
    }
    void pending.then(release, release)
    void pending
      .then(
        (value) => (abandoned ? late?.(value, performance.now() - started) : undefined),
        () => undefined
      )
      .catch((error) => Log.tag('ContextVerificationSession').error(error))
    try {
      const value = await awaitContextOperation(pending, combined)
      verificationFingerprint(value)
      checkVerificationCost(value.cost)
      return value
    } catch (error) {
      abandoned = true
      signal.throwIfAborted()
      if ((error as { code?: string }).code === 'VALIDATION') throw error
      return { status: 'unknown' }
    } finally {
      timers.dispose()
    }
  }

  private async append(
    attempt: ContextVerificationAttempt,
    expected?: string,
    signal?: AbortSignal
  ): Promise<ContextRef> {
    const { storage, context, sessionId } = this.options
    if (!expected)
      return (
        await context.append({
          kind: 'audit',
          title: `task:verification:${attempt.taskId}:${attempt.attemptId}:${attempt.phase}`,
          body: JSON.stringify(attempt),
          sources: [],
        })
      ).ref
    const body = JSON.stringify(attempt)
    const objectId = await storage.put(sessionId, body)
    const ref = { sessionId, id: crypto.randomUUID() }
    for (let retry = 0; retry < 32; retry++) {
      signal?.throwIfAborted()
      const state = await storage.load(sessionId)
      if (!state || (await this.boundary()) !== expected)
        throw contextFailure('CONFLICT', '核查发布时任务或授权边界已变化')
      const record = {
        ref,
        kind: 'audit' as const,
        title: `task:verification:${attempt.taskId}:${attempt.attemptId}:${attempt.phase}`,
        objectId,
        chars: body.length,
        sources: [],
        createdAt: new Date().toISOString(),
      }
      signal?.throwIfAborted()
      if (
        await storage.compareAndSwap(sessionId, state.version, {
          ...state,
          version: state.version + 1,
          records: [
            ...state.records,
            { ...record, sequence: (state.records.at(-1)?.sequence ?? 0) + 1 },
          ],
        })
      )
        return ref
    }
    throw contextFailure('CONFLICT', '核查证明发布持续冲突')
  }

  public async open(
    taskId: string,
    binding: Optional<ContextCompletionBinding>,
    signal: AbortSignal
  ): Promise<ContextVerificationContext> {
    const boundary = await this.boundary()
    if (JSON.parse(boundary)[1] !== taskId) throw contextFailure('CONFLICT', '领域核查任务已变化')
    let calls = 0
    return {
      check: (spec, execute) => {
        if (++calls > ContextVerificationLimits.checks)
          throw contextFailure('LIMIT', '一次领域验收的检查项超出上限')
        return this.check(
          {
            id: spec.id,
            scope: spec.scope,
            verifierId: spec.verifierId,
            verifierVersion: spec.verifierVersion,
            probe: (probeSignal) => spec.probe(probeSignal),
          },
          execute,
          taskId,
          binding,
          boundary,
          signal
        )
      },
    }
  }

  private async check(
    spec: ContextVerificationSpec,
    execute: (signal: AbortSignal) => Promise<ContextVerificationExecution>,
    taskId: string,
    binding: Optional<ContextCompletionBinding>,
    boundary: string,
    signal: AbortSignal
  ): Promise<ContextVerificationCheck> {
    checkVerificationSpec(spec)
    signal.throwIfAborted()
    if ((await this.boundary()) !== boundary)
      throw contextFailure('CONFLICT', '领域核查任务或授权已变化')
    this.current.set(spec.id, spec)
    while (this.current.size > ContextVerificationLimits.cachedChecks)
      this.current.delete(this.current.keys().next().value!)
    const started = performance.now()
    const attempt: ContextVerificationAttempt = {
      attemptId: crypto.randomUUID(),
      taskId,
      binding,
      checkId: spec.id,
      scope: spec.scope,
      verifierId: spec.verifierId,
      verifierVersion: spec.verifierVersion,
      authorizationBoundary: boundary,
      phase: 'started',
      mode: 'executed',
      status: 'pending',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      probeMs: 0,
      runMs: 0,
      applicability: 'unknown',
      cost: { coverage: 'unknown', charges: [] },
    }
    await this.append(attempt)
    let probeMs = 0
    let runMs = 0
    let mode: ContextVerificationAttempt['mode'] = 'executed'
    const costs: ContextVerificationCost[] = []
    let closed = false
    let settled = false
    let before: Optional<ContextVerificationFingerprint>
    let after: Optional<ContextVerificationFingerprint>
    let actual: Optional<ContextVerificationCheck>
    const probe = async () => {
      const probeStart = performance.now()
      const priorProbeMs = probeMs
      try {
        return await this.probe(spec, signal, async (value, durationMs) => {
          await this.append({
            ...attempt,
            phase: 'late-result',
            mode,
            status: signal.aborted ? 'cancelled' : 'unknown',
            settledAt: new Date().toISOString(),
            durationMs: performance.now() - started,
            probeMs: priorProbeMs + durationMs,
            runMs,
            cost: mergeVerificationCosts([...costs, checkVerificationCost(value.cost)]),
          })
        })
      } finally {
        probeMs += performance.now() - probeStart
      }
    }
    try {
      const pre = await probe()
      before = pre
      costs.push(checkVerificationCost(pre.cost))
      const fingerprint = verificationFingerprint(pre)
      const key = JSON.stringify([boundary, verificationSpecKey(spec), fingerprint])
      let cached = fingerprint ? this.proofs.get(key) : undefined
      let reusedSnapshot: Optional<ContextVerificationFingerprint>
      if (cached) {
        const matched = await probe()
        costs.push(checkVerificationCost(matched.cost))
        if (verificationFingerprint(matched) !== fingerprint) cached = undefined
        else reusedSnapshot = matched
      }
      let check: ContextVerificationCheck
      if (cached) {
        mode = 'reused'
        check = { ...structuredClone(cached.check), reusedFrom: cached.check.proofRef }
      } else {
        const runStart = performance.now()
        const pending = Promise.resolve().then(() => execute(signal))
        void pending
          .then(
            async (late) => {
              if (!closed) return
              await this.append({
                ...attempt,
                phase: 'late-result',
                status: 'cancelled',
                durationMs: performance.now() - started,
                settledAt: new Date().toISOString(),
                probeMs,
                runMs: performance.now() - runStart,
                check: {
                  ...verificationExecutionCheck(
                    spec,
                    late,
                    new Date().toISOString(),
                    pre.status === 'versioned' ? pre.artifacts : undefined
                  ),
                  applicability: 'unknown',
                },
                cost: mergeVerificationCosts([...costs, checkVerificationCost(late.cost)]),
              })
            },
            () => {
              /* 失败由当前等待方记录；迟到失败保持 cancelled 与未知费用。 */
            }
          )
          .catch((error) => Log.tag('ContextVerificationSession').error(error))
        let result: ContextVerificationExecution
        try {
          result = await awaitContextOperation(pending, signal)
        } finally {
          runMs = performance.now() - runStart
        }
        costs.push(checkVerificationCost(result.cost))
        check = verificationExecutionCheck(
          spec,
          result,
          new Date().toISOString(),
          pre.status === 'versioned' ? pre.artifacts : undefined
        )
        for (const ref of check.evidenceRefs ?? [])
          await this.options.context.read(ref, { limit: 1 })
      }
      actual = structuredClone(check)
      const post = reusedSnapshot ?? (await probe())
      after = post
      if (!reusedSnapshot) {
        costs.push(checkVerificationCost(post.cost))
      }
      signal.throwIfAborted()
      if ((await this.boundary()) !== boundary)
        throw contextFailure('CONFLICT', '领域核查期间任务或授权已变化')
      const postFingerprint = verificationFingerprint(post)
      const applicability =
        fingerprint && postFingerprint === fingerprint
          ? ('current' as const)
          : postFingerprint && fingerprint
            ? ('historical' as const)
            : ('unknown' as const)
      const actualCheck = { ...check, applicability }
      actual = actualCheck
      // 产物核查中发生变化时，实际成功仍是历史事实，本次范围不能冒充已检查当前产物。
      if (applicability === 'historical' || (cached && applicability !== 'current'))
        check = { ...check, status: 'unknown', complete: false }
      check = { ...check, applicability }
      const proofRef = await this.append(
        {
          ...attempt,
          phase: 'settled',
          mode,
          status: check.status,
          check: actualCheck,
          before: pre,
          after: post,
          settledAt: new Date().toISOString(),
          durationMs: performance.now() - started,
          probeMs,
          runMs,
          applicability,
          cost: mergeVerificationCosts(costs),
        },
        boundary,
        signal
      )
      closed = true
      settled = true
      signal.throwIfAborted()
      check = { ...check, proofRef: cached ? cached.check.proofRef : proofRef }
      if (fingerprint) {
        this.history.set(proofRef.id, {
          boundary,
          spec,
          fingerprint,
          check: structuredClone({ ...actualCheck, proofRef }),
        })
        while (this.history.size > ContextVerificationLimits.cachedChecks)
          this.history.delete(this.history.keys().next().value!)
      }
      if (
        fingerprint &&
        applicability === 'current' &&
        check.status === 'passed' &&
        check.complete
      ) {
        this.proofs.set(key, { boundary, spec, fingerprint, check: structuredClone(check) })
        while (this.proofs.size > ContextVerificationLimits.cachedChecks)
          this.proofs.delete(this.proofs.keys().next().value!)
      }
      return check
    } catch (error) {
      closed = true
      let cost: ContextVerificationCost = { coverage: 'unknown', charges: [] }
      try {
        cost = mergeVerificationCosts([...costs, cost])
      } catch (costError) {
        Log.tag('ContextVerificationSession').error('核查费用依据合并失败', costError)
      }
      if (!settled)
        await this.append({
          ...attempt,
          phase: 'settled',
          mode,
          status: signal.aborted ? 'cancelled' : 'unknown',
          settledAt: new Date().toISOString(),
          durationMs: performance.now() - started,
          probeMs,
          runMs,
          check: actual,
          before,
          after,
          cost,
        })
      throw error
    }
  }

  public async applicability(
    ref: ContextRef,
    record: ContextCompletionRecord,
    signal: AbortSignal
  ): Promise<ContextCompletionApplicability> {
    let boundary = ''
    try {
      boundary = await this.boundary()
    } catch (error) {
      signal.throwIfAborted()
      Log.tag('ContextVerificationSession').debug('核查所属当前边界不可用', error)
    }
    const checks = []
    for (const check of record.result.report?.checks ?? []) {
      signal.throwIfAborted()
      const spec = check.id ? this.current.get(check.id) : undefined
      const proof = [...this.history.values()].find(
        (item) =>
          item.check.proofRef?.id === check.proofRef?.id &&
          item.check.proofRef?.sessionId === check.proofRef?.sessionId
      )
      let status: ContextCompletionApplicability['checks'][number]['status'] = 'unknown'
      if (record.taskId !== JSON.parse(boundary || '[null,null]')[1]) status = 'historical'
      else if (spec && proof) {
        if (
          verificationSpecKey(spec) !== verificationSpecKey(proof.spec) ||
          boundary !== proof.boundary
        )
          status = 'historical'
        else {
          const started = performance.now()
          const attempt: ContextVerificationAttempt = {
            attemptId: crypto.randomUUID(),
            taskId: record.taskId,
            binding: record.binding,
            checkId: spec.id,
            scope: spec.scope,
            verifierId: spec.verifierId,
            verifierVersion: spec.verifierVersion,
            authorizationBoundary: boundary,
            phase: 'started',
            mode: 'probed',
            status: 'pending',
            startedAt: new Date().toISOString(),
            durationMs: 0,
            probeMs: 0,
            runMs: 0,
            applicability: 'unknown',
            cost: { coverage: 'unknown', charges: [] },
          }
          await this.append(attempt)
          const probeStart = performance.now()
          let probeMs = 0
          try {
            const snapshot = await this.probe(spec, signal, async (value, durationMs) => {
              await this.append({
                ...attempt,
                phase: 'late-result',
                status: signal.aborted ? 'cancelled' : 'unknown',
                settledAt: new Date().toISOString(),
                durationMs,
                probeMs: durationMs,
                cost: checkVerificationCost(value.cost),
              })
            })
            probeMs = performance.now() - probeStart
            const fingerprint = verificationFingerprint(snapshot)
            if (fingerprint) status = fingerprint === proof.fingerprint ? 'current' : 'historical'
            try {
              if ((await this.boundary()) !== boundary) status = 'historical'
            } catch (error) {
              signal.throwIfAborted()
              status = 'historical'
              Log.tag('ContextVerificationSession').debug('适用性探测期间当前任务已变化', error)
            }
            await this.append({
              ...attempt,
              phase: 'settled',
              status: 'unknown',
              settledAt: new Date().toISOString(),
              durationMs: performance.now() - started,
              probeMs,
              after: snapshot,
              applicability: status,
              cost: checkVerificationCost(snapshot.cost),
            })
          } catch (error) {
            await this.append({
              ...attempt,
              phase: 'settled',
              status: signal.aborted ? 'cancelled' : 'unknown',
              settledAt: new Date().toISOString(),
              durationMs: performance.now() - started,
              probeMs: probeMs || performance.now() - probeStart,
            })
            throw error
          }
        }
      }
      checks.push({ id: check.id, proofRef: check.proofRef, status })
    }
    return { ref, checkedAt: new Date().toISOString(), checks }
  }
}
