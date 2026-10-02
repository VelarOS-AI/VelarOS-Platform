import { describe, expect, test } from 'bun:test'

import type { ContextStorage, ContextVerificationSpec } from '../src/contract/requires.js'
import { createContextView } from '../src/impl/ContextViewSession.js'
import { createContextRuntime } from '../src/impl/SessionContext.js'
import type { ContextState, ContextVerificationAttempt } from '../src/types/context.js'

const zero = { coverage: 'complete' as const, charges: [] }
async function fixture() {
  let state: ContextState | null = null
  const objects = new Map<string, string>()
  const storage: ContextStorage = {
    load: async () => structuredClone(state),
    get: async (_session, id) => objects.get(id) ?? null,
    put: async (_session, body) => {
      const id = crypto.randomUUID()
      objects.set(id, body)
      return id
    },
    compareAndSwap: async (_session, version, next) => {
      if ((state?.version ?? 0) !== version) return false
      state = structuredClone(next)
      return true
    },
    close: async () => {},
  }
  const context = createContextRuntime({ sessionId: 'checks', storage })
  const options = { sessionId: 'checks', storage, context, sources: [] }
  const view = createContextView(options)
  const input = await context.append({ kind: 'user', body: '检查业务产物，保护输入' })
  await view.begin(input.ref)
  await view.build({ maxChars: 12000 })
  const artifact = { identity: 'artifact.json', contentHash: 'exact-bytes-v1', revision: 'r1' }
  const domain = {
    token: '1',
    authorization: 'auth-1',
    providerId: 'provider-1',
    unknown: false,
    artifact,
  }
  const spec: ContextVerificationSpec = {
    id: 'parse',
    scope: 'document/schema-v1/whole',
    verifierId: 'parser',
    verifierVersion: '1',
    probe: async () =>
      domain.unknown
        ? { status: 'unknown', cost: zero }
        : {
            status: 'versioned',
            providerId: domain.providerId,
            token: domain.token,
            authorization: domain.authorization,
            artifacts: [domain.artifact],
            cost: zero,
          },
  }
  const attempts = async () => {
    const current = await storage.load('checks')
    return Promise.all(
      (current?.records ?? [])
        .filter((record) => record.title.startsWith('task:verification:'))
        .map(
          async (record) =>
            JSON.parse(
              (await storage.get('checks', record.objectId))!
            ) as ContextVerificationAttempt
        )
    )
  }
  const complete = async (
    execute: (signal: AbortSignal) => Promise<any>,
    descriptor = spec,
    signal?: AbortSignal
  ) =>
    view.complete(
      {
        verify: async (_view, _signal, checks) => {
          const check = await checks!.check(descriptor, execute)
          return {
            verified: false,
            reason: '仍有其他业务检查',
            report: { scope: '业务范围', checkedAt: new Date().toISOString(), checks: [check] },
          }
        },
      },
      signal
    )
  return { view, context, options, storage, input, domain, spec, complete, attempts }
}

describe('INV-16 领域逐项核查复用和不可变尝试账', () => {
  test('失败后的完整成功检查可复用，保留原检查时间与证明，只记本次探测成本', async () => {
    const f = await fixture()
    let runs = 0
    const execute = async () => ({
      label: '解析产物',
      status: 'passed' as const,
      complete: true,
      cost: {
        coverage: 'complete' as const,
        charges: [
          {
            id: `charge-${++runs}`,
            kind: 'external' as const,
            currency: 'USD',
            basis: 'actual' as const,
            amount: 0.2,
          },
        ],
      },
    })
    const first = await f.complete(execute)
    const second = await f.complete(execute)
    expect(runs).toBe(1)
    expect(second.report!.checks[0].checkedAt).toBe(first.report!.checks[0].checkedAt)
    expect(second.report!.checks[0].reusedFrom).toEqual(first.report!.checks[0].proofRef)
    const settled = (await f.attempts()).filter((attempt) => attempt.phase === 'settled')
    expect(settled.map((attempt) => attempt.mode)).toEqual(['executed', 'reused'])
    expect(settled[0].cost.charges[0].amount).toBe(0.2)
    expect(settled[1].cost).toEqual(zero)
    expect(
      settled.every((attempt) => attempt.durationMs >= attempt.runMs && attempt.probeMs >= 0)
    ).toBe(true)
    const current = await f.view.completionApplicability()
    expect(current!.checks[0].status).toBe('current')
    f.domain.token = '2'
    f.domain.artifact.contentHash = 'exact-bytes-v2'
    expect((await f.view.completionApplicability())!.checks[0].status).toBe('historical')
    expect((await f.view.readCompletion())!.result.report!.checks[0].status).toBe('passed')
    await f.complete(execute)
    expect(runs).toBe(2)
  })

  test('scope、判据版本、产物集合、授权、provider与ABA代次分别使复用失效', async () => {
    for (const changed of [
      'scope',
      'verifierVersion',
      'bytes',
      'revision',
      'authorization',
      'provider',
      'aba',
    ]) {
      const f = await fixture()
      let runs = 0
      const execute = async () => {
        runs++
        return { label: '结构', status: 'passed' as const, complete: true, cost: zero }
      }
      await f.complete(execute)
      const next = { ...f.spec }
      if (changed === 'scope') next.scope = 'different-business-criterion'
      if (changed === 'verifierVersion') next.verifierVersion = '2'
      if (changed === 'bytes') f.domain.artifact.contentHash = 'different'
      if (changed === 'revision') f.domain.artifact.revision = 'r2'
      if (changed === 'authorization') f.domain.authorization = 'auth-2'
      if (changed === 'provider') f.domain.providerId = 'provider-2'
      if (changed === 'aba') f.domain.token = '3'
      await f.complete(execute, next)
      expect(runs).toBe(2)
    }
  })

  test('unknown不复用但真实执行保持实际结果；失败和部分覆盖每次重新核查', async () => {
    for (const variant of ['unknown', 'failed', 'partial']) {
      const f = await fixture()
      if (variant === 'unknown') f.domain.unknown = true
      let runs = 0
      const execute = async () => {
        runs++
        return {
          label: '业务检查',
          status: variant === 'failed' ? ('failed' as const) : ('passed' as const),
          complete: variant !== 'partial',
          cost: zero,
        }
      }
      const first = await f.complete(execute)
      await f.complete(execute)
      expect(runs).toBe(2)
      if (variant === 'unknown') expect(first.report!.checks[0].status).toBe('passed')
    }
  })

  test('核查过程中产物变化，旧执行结果不能作为当前通过证明', async () => {
    const f = await fixture()
    const result = await f.complete(async () => {
      f.domain.token = '2'
      f.domain.artifact.contentHash = 'v2'
      return { label: '结构', status: 'passed', complete: true, cost: zero }
    })
    expect(result.report!.checks[0].status).toBe('unknown')
    expect(result.report!.checks[0].complete).toBe(false)
    expect((await f.attempts()).at(-1)!.applicability).toBe('historical')
  })

  test('任务/权限水位改变与取消不发布可复用证明，尝试仍归原task', async () => {
    for (const variant of ['reset', 'cancel']) {
      const f = await fixture()
      const controller = new AbortController()
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        release = resolve
      })
      let settle!: (value: any) => void
      const execution = new Promise<any>((resolve) => {
        settle = resolve
      })
      const completing = f.complete(
        async () => {
          release()
          return execution
        },
        f.spec,
        controller.signal
      )
      await started
      if (variant === 'cancel') controller.abort()
      else await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
      settle({ label: '结构', status: 'passed', complete: true, cost: zero })
      await expect(completing).rejects.toBeDefined()
      for (let turn = 0; turn < 8; turn++) await Promise.resolve()
      expect(
        (await f.attempts()).some(
          (attempt) =>
            attempt.phase === 'settled' && ['cancelled', 'unknown'].includes(attempt.status)
        )
      ).toBe(true)
      if (variant === 'reset') expect((await f.attempts()).at(-1)!.check!.status).toBe('passed')
      expect((await f.view.inspect())!.status).not.toBe('completed')
    }
  })

  test('同一存储的重开视图保留历史账，清除复用；旧2参验收器正常工作', async () => {
    const f = await fixture()
    let runs = 0
    const execute = async () => {
      runs++
      return { label: '结构', status: 'passed' as const, complete: true, cost: zero }
    }
    const first = await f.complete(execute)
    const ref = (await f.view.inspect())!.completionRef!
    await f.view.end()
    const reopened = createContextView(f.options)
    await reopened.begin(f.input.ref)
    await reopened.build({ maxChars: 12000 })
    expect((await reopened.completionApplicability(ref))!.checks[0].status).toBe('unknown')
    const next = await reopened.complete({
      verify: async (_view, _signal, checks) => ({
        verified: false,
        reason: '其他业务检查',
        report: {
          scope: '业务范围',
          checkedAt: new Date().toISOString(),
          checks: [await checks!.check(f.spec, execute)],
        },
      }),
    })
    expect(runs).toBe(2)
    expect(next.report!.checks[0].reusedFrom).toBeUndefined()
    expect((await reopened.readCompletion(ref))!.result.report).toEqual(first.report)
    const legacy = await reopened.complete({
      verify: async (_view, _signal) => ({ verified: true, reason: '旧合同仍可用' }),
    })
    expect(legacy.completed).toBe(true)
  })

  test('精确产物集合顺序不影响复用，成员改变使完整检查失效；调用方变更不污染证明', async () => {
    const f = await fixture()
    const a = { identity: 'a.json', contentHash: 'a-full' }
    const b = { identity: 'b.json', contentHash: 'b-full' }
    let artifacts = [a, b]
    const spec = {
      ...f.spec,
      probe: async () => ({
        status: 'versioned' as const,
        providerId: 'p',
        token: '1',
        authorization: 'auth',
        artifacts,
        cost: zero,
      }),
    }
    let runs = 0
    const execute = async () => {
      runs++
      return { label: '全部产物', status: 'passed' as const, complete: true, cost: zero }
    }
    const first = await f.complete(execute, spec)
    ;(first.report!.checks[0] as { label: string }).label = '调用方改写'
    artifacts = [b, a]
    expect((await f.complete(execute, spec)).report!.checks[0].label).toBe('全部产物')
    expect(runs).toBe(1)
    artifacts = [a]
    await f.complete(execute, spec)
    expect(runs).toBe(2)
  })

  test('无关CAS竞争只重试核查事实发布，不重跑业务核查器或单项检查', async () => {
    const f = await fixture()
    const cas = f.storage.compareAndSwap.bind(f.storage)
    let raced = false
    f.storage.compareAndSwap = async (session, version, next) => {
      if (!raced && next.records.at(-1)?.title.endsWith(':settled')) {
        raced = true
        await f.context.append({ kind: 'audit', title: 'unrelated', body: '并发无关事件' })
      }
      return cas(session, version, next)
    }
    let verifies = 0
    let runs = 0
    const run = async () => {
      runs++
      return { label: '结构', status: 'passed' as const, complete: true, cost: zero }
    }
    await f.view.complete({
      verify: async (_view, _signal, checks) => {
        verifies++
        return {
          verified: false,
          reason: '其他范围待查',
          report: {
            scope: '业务',
            checkedAt: new Date().toISOString(),
            checks: [await checks!.check(f.spec, run)],
          },
        }
      },
    })
    expect(verifies).toBe(1)
    expect(runs).toBe(1)
    expect(
      (await f.storage.load('checks'))!.records.some((record) => record.title === 'unrelated')
    ).toBe(true)
    expect((await f.attempts()).filter((attempt) => attempt.phase === 'settled')).toHaveLength(1)
  })

  test('取消后迟到的真实费用归原attempt，状态保持取消且不建立可复用证明', async () => {
    const f = await fixture()
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish!: (value: any) => void
    const late = new Promise<any>((resolve) => {
      finish = resolve
    })
    const completing = f.complete(
      async () => {
        started()
        return late
      },
      f.spec,
      controller.signal
    )
    await ready
    controller.abort()
    await expect(completing).rejects.toBeDefined()
    finish({
      label: '结构',
      status: 'passed',
      complete: true,
      cost: {
        coverage: 'complete',
        charges: [
          { id: 'late-request', kind: 'model', currency: 'USD', basis: 'reference', amount: 0.1 },
        ],
      },
    })
    let attempts: ContextVerificationAttempt[] = []
    for (let iteration = 0; iteration < 64; iteration++) {
      attempts = await f.attempts()
      if (attempts.some((attempt) => attempt.phase === 'late-result')) break
      await Promise.resolve()
    }
    const cancelled = attempts.find((attempt) => attempt.phase === 'settled')!
    const charged = attempts.find((attempt) => attempt.phase === 'late-result')!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cost.coverage).toBe('partial')
    expect(charged.attemptId).toBe(cancelled.attemptId)
    expect(charged.taskId).toBe(cancelled.taskId)
    expect(charged.cost.charges[0].id).toBe('late-request')
    expect(charged.check!.status).toBe('passed')
    expect(charged.check!.applicability).toBe('unknown')
    let runs = 0
    await f.complete(async () => {
      runs++
      return { label: '结构', status: 'passed', complete: true, cost: zero }
    })
    expect(runs).toBe(1)
  })

  test('费用证据按charge ID去重；未报告费用保持unknown，错误探测不进入缓存', async () => {
    const f = await fixture()
    const cost = {
      coverage: 'complete' as const,
      charges: [
        {
          id: 'one-billed-request',
          kind: 'external' as const,
          currency: 'USD',
          basis: 'actual' as const,
          amount: 0.03,
        },
      ],
    }
    const spec = {
      ...f.spec,
      probe: async () => ({
        status: 'versioned' as const,
        providerId: 'p',
        token: '1',
        authorization: 'a',
        artifacts: [f.domain.artifact],
        cost,
      }),
    }
    await f.complete(async () => ({ label: '结构', status: 'passed', complete: true, cost }), spec)
    expect((await f.attempts()).at(-1)!.cost.charges).toHaveLength(1)
    const other = await fixture()
    await other.complete(async () => ({ label: '结构', status: 'passed', complete: true }))
    expect((await other.attempts()).at(-1)!.cost.coverage).toBe('partial')
    const broken = {
      ...other.spec,
      id: 'invalid',
      probe: async () => ({
        status: 'versioned' as const,
        providerId: 'p',
        token: '1',
        authorization: 'a',
        artifacts: [],
      }),
    }
    let runs = 0
    await expect(
      other.complete(async () => {
        runs++
        return { label: '结构', status: 'passed', complete: true }
      }, broken)
    ).rejects.toBeDefined()
    expect(runs).toBe(0)
    expect((await other.attempts()).at(-1)!.status).toBe('unknown')
  })

  test('取消探测保留等待耗时，迟到probe费用归原attempt且不执行检查', async () => {
    const f = await fixture()
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish!: (value: any) => void
    const pending = new Promise<any>((resolve) => {
      finish = resolve
    })
    const spec = {
      ...f.spec,
      probe: async () => {
        started()
        return pending
      },
    }
    let runs = 0
    const completing = f.complete(
      async () => {
        runs++
        return { label: '结构', status: 'passed', complete: true, cost: zero }
      },
      spec,
      controller.signal
    )
    await ready
    controller.abort()
    await expect(completing).rejects.toBeDefined()
    finish({
      status: 'unknown',
      cost: {
        coverage: 'complete',
        charges: [
          { id: 'late-probe', kind: 'external', currency: 'USD', basis: 'actual', amount: 0.02 },
        ],
      },
    })
    let attempts: ContextVerificationAttempt[] = []
    for (let iteration = 0; iteration < 64; iteration++) {
      attempts = await f.attempts()
      if (attempts.some((attempt) => attempt.phase === 'late-result')) break
      await Promise.resolve()
    }
    expect(runs).toBe(0)
    const settled = attempts.find((attempt) => attempt.phase === 'settled')!
    const late = attempts.find((attempt) => attempt.phase === 'late-result')!
    expect(settled.probeMs).toBeGreaterThan(0)
    expect(settled.runMs).toBe(0)
    expect(late.attemptId).toBe(settled.attemptId)
    expect(late.status).toBe('cancelled')
    expect(late.cost.charges[0].id).toBe('late-probe')
  })

  test('当前适用性查询真实probe独立入账，不复制原检查收费', async () => {
    const f = await fixture()
    let probes = 0
    const original = f.spec.probe
    const spec = {
      ...f.spec,
      probe: async (signal: AbortSignal) => ({
        ...(await original(signal)),
        cost: {
          coverage: 'complete' as const,
          charges: [
            {
              id: `probe-${++probes}`,
              kind: 'external' as const,
              currency: 'USD',
              basis: 'actual' as const,
              amount: 0.01,
            },
          ],
        },
      }),
    }
    await f.complete(
      async () => ({
        label: '结构',
        status: 'passed',
        complete: true,
        cost: {
          coverage: 'complete',
          charges: [
            {
              id: 'business-check',
              kind: 'external',
              currency: 'USD',
              basis: 'actual',
              amount: 0.3,
            },
          ],
        },
      }),
      spec
    )
    expect((await f.view.completionApplicability())!.checks[0].status).toBe('current')
    const settled = (await f.attempts()).filter((attempt) => attempt.phase === 'settled')
    expect(settled.map((attempt) => attempt.mode)).toEqual(['executed', 'probed'])
    expect(probes).toBe(3)
    expect(settled[1].runMs).toBe(0)
    expect(settled[1].cost.charges.map((charge) => charge.id)).toEqual(['probe-3'])
    expect(settled[1].after!.status).toBe('versioned')
  })

  test('同一视图切换新任务后不复用旧证明，旧报告明确历史', async () => {
    const f = await fixture()
    let runs = 0
    const execute = async () => {
      runs++
      return { label: '结构', status: 'passed' as const, complete: true, cost: zero }
    }
    await f.complete(execute)
    const previous = (await f.view.inspect())!
    await f.view.end()
    const input = await f.context.append({ kind: 'user', body: '新任务，重新核查相同产物' })
    await f.view.begin(input.ref, undefined, 'new')
    await f.view.build({ maxChars: 12000 })
    expect((await f.view.completionApplicability(previous.completionRef))!.checks[0].status).toBe(
      'historical'
    )
    await f.complete(execute)
    expect(runs).toBe(2)
    expect((await f.view.inspect())!.id).not.toBe(previous.id)
    expect(
      (await f.view.readCompletion(previous.completionRef))!.result.report!.checks[0].status
    ).toBe('passed')
  })
})
