import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

import { FullCapabilities, journey, observation, trial } from '../spec/support.js'
import type {
  BudgetUsage,
  JobSpec,
  LabDriver,
  Observation,
  RunArchive,
  SettleOutcome,
  VerifierRegistryApi,
} from '../src/index.js'
import {
  createDetectorRegistry,
  createVerifierRegistry,
  journeyRunner,
  UnlimitedBudget,
} from '../src/index.js'

function passingVerifiers(): VerifierRegistryApi {
  const verifiers = createVerifierRegistry()
  verifiers.register('complete', () => ({
    kind: 'pass',
    credit: 1,
    evidence: {},
  }))
  return verifiers
}

/** 每次 waitSettled 让假时钟走 `legMs`：用来把「本段用时」与「整程用时」分开。 */
function clockedDriver(clock: { value: number }, legMs: number): LabDriver {
  const session = {
    id: 'session',
    executorId: 'executor-a',
    externalId: 'native',
    metadata: {},
  }
  return {
    id: 'fake',
    capabilities: async () => FullCapabilities,
    identity: async () => ({
      executorId: 'executor-a',
      adapterVersion: '1',
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    }),
    openSession: async () => session,
    prepare: async () => undefined,
    send: async () => undefined,
    waitSettled: async (_session, request) => {
      clock.value += legMs
      const decision = await request.onSample({
        observation: observation('running'),
        usage: {
          toolCalls: 0,
          workingMs: legMs,
          wallClockMs: legMs,
          tokens: 1,
          legs: 0,
        },
      })
      if (decision.kind === 'abort')
        return {
          kind: 'aborted',
          detectorId: decision.detectorId,
          reason: decision.reason,
        }
      return { kind: 'settled' }
    },
    collect: async (_session, phase) => observation(phase),
    abort: async () => undefined,
    closeSession: async () => undefined,
  }
}

function cumulativeObservation(ids: readonly string[], tokens: number | null): Observation {
  const base = observation()
  return {
    ...base,
    turns: [
      {
        id: 'turns',
        index: 1,
        finishReasons: [],
        toolCalls: ids.map((id) => ({
          id,
          turnId: 'turns',
          name: 'read',
          input: { id },
          result: null,
          isError: false,
          startedAt: null,
          finishedAt: null,
        })),
      },
    ],
    usage: { ...base.usage!, totalTokens: tokens },
  }
}

/** 快照包含整个会话；每段原生读数连续重复两次，检验采样去重与段结算。 */
function sampledDriver(
  clock: { value: number },
  snapshots: readonly Observation[],
  usages: readonly BudgetUsage[]
): LabDriver {
  const driver = clockedDriver(clock, 10)
  let completed = 0
  driver.collect = async (_session, phase) => ({ ...snapshots[completed]!, phase })
  driver.waitSettled = async (_session, request) => {
    const usage = usages[completed]!
    completed += 1
    clock.value += 10
    for (let sample = 0; sample < 2; sample += 1) {
      const decision = await request.onSample({
        observation: { ...snapshots[completed]!, phase: 'running' },
        usage,
      })
      if (decision.kind === 'abort')
        return { kind: 'aborted', detectorId: decision.detectorId, reason: decision.reason }
    }
    return { kind: 'settled' }
  }
  return driver
}

describe('归档里的 harness 版本', () => {
  test('缺省用本包真实版本，不再是写死的 0.1.0', async () => {
    const clock = { value: 1_000 }
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: journey(),
      driver: clockedDriver(clock, 10),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string }

    expect(result.manifest.harness.packageVersion).toBe(manifest.version)
    expect(result.manifest.harness.packageVersion).not.toBe('0.1.0')
  })
})

describe('段预算的口径', () => {
  test('send、等待或采集失败仍保留本段真实开始时间和释放事实', async () => {
    for (const phase of ['send', 'waitSettled', 'collect'] as const) {
      const clock = { value: 100 }
      const startedAt = clock.value
      const driver = clockedDriver(clock, 2_000)
      const failure = new Error(`${phase} failed after work`)
      const closed: string[] = []
      const failAfterWork = async () => {
        clock.value += 3_000
        throw failure
      }
      if (phase === 'collect') {
        let reads = 0
        driver.collect = async (_session, collectPhase) => {
          // 第一读是新增的真实发送前基线；故障仍发生在执行后的采集。
          if (reads++ === 0) return observation(collectPhase)
          return failAfterWork()
        }
      } else driver[phase] = failAfterWork
      driver.closeSession = async (session) => {
        closed.push(session.id)
      }
      const result = await journeyRunner.runJourney({
        jobId: 'job',
        suiteId: 'suite',
        trial: trial(),
        journey: journey(),
        driver,
        detectors: createDetectorRegistry(),
        verifiers: passingVerifiers(),
        workspaceRoot: null,
        sourceCommit: null,
        consumerCommit: null,
        now: () => clock.value,
      })
      const elapsed = phase === 'collect' ? 5_000 : 3_000
      expect(result.legs).toHaveLength(1)
      const leg = result.legs[0]!
      expect(leg.startedAt).toBe(startedAt)
      expect(leg.finishedAt).toBe(startedAt + elapsed)
      expect(leg.finishedAt - leg.startedAt).toBe(elapsed)
      expect(leg.settleOutcome).toEqual({
        kind: 'unavailable',
        cause: 'harness-failure',
        detail: failure.message,
      })
      expect(leg.passed).toBeNull()
      expect(result.drops).toEqual([
        {
          trialId: trial().id,
          legId: leg.legId,
          cause: 'harness-failure',
          detail: failure.message,
        },
      ])
      expect(result.manifest.usage.wallClockMs).toBe(elapsed)
      expect(result.manifest.exitReason).toBe('harness-failure')
      expect(closed).toEqual(['session'])
    }
  })

  test('第二段按本段用时判，不再被整程用时判成超预算', async () => {
    const clock = { value: 0 }
    const definition = journey('journey-a', 2)
    const [first, second] = definition.legs
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: {
        ...definition,
        // 整程不限时；两段各跑 5 秒，第二段自己的上限是 8 秒。
        budget: { ...UnlimitedBudget, legs: 2 },
        legs: [first!, { ...second!, budget: { ...UnlimitedBudget, wallClockMs: 8_000 } }],
      },
      driver: clockedDriver(clock, 5_000),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })

    expect(result.legs).toHaveLength(2)
    expect(result.legs[1]?.settleOutcome.kind).toBe('settled')
    expect(result.manifest.exitReason).toBe('completed')
  })

  test('本段真的超了本段预算时照样判超', async () => {
    const clock = { value: 0 }
    const definition = journey('journey-a', 1)
    const [only] = definition.legs
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: {
        ...definition,
        budget: { ...UnlimitedBudget, legs: 1 },
        legs: [{ ...only!, budget: { ...UnlimitedBudget, wallClockMs: 1_000 } }],
      },
      driver: clockedDriver(clock, 5_000),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })

    expect(result.legs[0]?.settleOutcome).toEqual({
      kind: 'budget-exhausted',
      limit: 'wallClockMs',
    })
    expect(result.legs[0]?.criteria[0]?.outcome).toMatchObject({
      kind: 'fail',
      failureClass: 'budget-exhausted',
    })
  })

  test('uses actual cumulative baselines and counts native segment samples once', async () => {
    const clock = { value: 0 }
    const definition = journey('journey-a', 2)
    const ids = ['a', 'b', 'c', 'd', 'e']
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: {
        ...definition,
        budget: { ...UnlimitedBudget, legs: 2 },
        legs: [
          definition.legs[0]!,
          {
            ...definition.legs[1]!,
            budget: { ...UnlimitedBudget, toolCalls: 2, tokens: 20, workingMs: 15 },
          },
        ],
      },
      driver: sampledDriver(
        clock,
        [
          cumulativeObservation([], 0),
          cumulativeObservation(ids, 100),
          cumulativeObservation([...ids, 'f'], 110),
        ],
        [
          { toolCalls: 5, tokens: 100, workingMs: 10, wallClockMs: 10, legs: 1 },
          { toolCalls: 1, tokens: 10, workingMs: 10, wallClockMs: 10, legs: 1 },
        ]
      ),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })
    expect(result.legs.map((leg) => leg.settleOutcome.kind)).toEqual(['settled', 'settled'])
    expect(result.manifest.usage).toEqual({
      toolCalls: 6,
      tokens: 110,
      workingMs: 20,
      wallClockMs: 20,
      legs: 2,
    })
  })

  test('does not invent baselines from partial history or unknown tokens when native segment usage is known', async () => {
    const clock = { value: 0 }
    const baseline = cumulativeObservation(['visible-old'], null)
    const definition = journey()
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: {
        ...definition,
        budget: { ...UnlimitedBudget, legs: 1 },
        legs: [
          {
            ...definition.legs[0]!,
            budget: { ...UnlimitedBudget, toolCalls: 1, tokens: 20 },
          },
        ],
      },
      driver: sampledDriver(
        clock,
        [
          { ...baseline, coverage: { ...baseline.coverage, turns: 'partial' } },
          cumulativeObservation(['visible-old', 'hidden-old', 'new'], 100),
        ],
        [{ toolCalls: 1, tokens: 10, workingMs: null, wallClockMs: 10, legs: 1 }]
      ),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })
    expect(result.legs[0]?.settleOutcome.kind).toBe('settled')
    expect(result.manifest.usage).toMatchObject({
      toolCalls: 3,
      tokens: 100,
      workingMs: null,
      legs: 1,
    })
  })

  test('keeps unknown native segments unknown and enforces real journey totals despite a null segment override', async () => {
    const unobserved: Observation = {
      ...observation(),
      coverage: { ...FullCapabilities.observes, turns: 'none', usage: 'none' },
      usage: null,
    }
    for (const field of ['toolCalls', 'tokens', 'workingMs'] as const) {
      const clock = { value: 0 }
      const definition = journey('journey-a', 2)
      const usage = { toolCalls: 0, tokens: 0, workingMs: 0, wallClockMs: 10, legs: 1, [field]: 1 }
      const result = await journeyRunner.runJourney({
        jobId: 'job',
        suiteId: 'suite',
        trial: trial(),
        journey: {
          ...definition,
          budget: { ...UnlimitedBudget, legs: 2, [field]: 1 },
          legs: [
            definition.legs[0]!,
            {
              ...definition.legs[1]!,
              budget: { ...UnlimitedBudget, [field]: null },
            },
          ],
        },
        driver: sampledDriver(clock, [unobserved, unobserved, unobserved], [usage, usage]),
        detectors: createDetectorRegistry(),
        verifiers: passingVerifiers(),
        workspaceRoot: null,
        sourceCommit: null,
        consumerCommit: null,
        now: () => clock.value,
      })
      expect(result.legs[0]?.settleOutcome.kind).toBe('settled')
      expect(result.legs[1]?.settleOutcome).toEqual({ kind: 'budget-exhausted', limit: field })
      expect(result.legs[1]?.criteria[0]?.outcome).toMatchObject({
        kind: 'fail',
        failureClass: 'budget-exhausted',
      })
      expect(result.manifest.usage[field]).toBe(2)
      expect(result.manifest.usage.legs).toBe(2)
    }
    const clock = { value: 0 }
    const definition = journey('journey-a', 2)
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: { ...definition, budget: { ...UnlimitedBudget, legs: 2 } },
      driver: sampledDriver(
        clock,
        [unobserved, unobserved, unobserved],
        [
          { toolCalls: 1, tokens: 30, workingMs: null, wallClockMs: 10, legs: 1 },
          { toolCalls: null, tokens: null, workingMs: 10, wallClockMs: 10, legs: 1 },
        ]
      ),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })
    expect(result.manifest.usage).toEqual({
      toolCalls: null,
      tokens: null,
      workingMs: null,
      wallClockMs: 20,
      legs: 2,
    })
  })

  test('awaits real segment-budget interruption before closing and retains the exhausted dimension', async () => {
    for (const field of ['toolCalls', 'tokens', 'workingMs'] as const) {
      const clock = { value: 0 }
      const unobserved: Observation = {
        ...observation(),
        coverage: { ...FullCapabilities.observes, turns: 'none', usage: 'none' },
        usage: null,
      }
      const driver = sampledDriver(
        clock,
        [unobserved, unobserved],
        [{ toolCalls: 0, tokens: 0, workingMs: 0, wallClockMs: 10, legs: 1, [field]: 2 }]
      )
      const events: string[] = []
      let releaseAbort!: () => void
      let enteredAbort!: () => void
      const draining = new Promise<void>((resolve) => {
        releaseAbort = resolve
      })
      const entered = new Promise<void>((resolve) => {
        enteredAbort = resolve
      })
      driver.abort = async () => {
        events.push('abort-start')
        enteredAbort()
        await draining
        events.push('abort-finished')
      }
      driver.closeSession = async () => {
        events.push('closed')
      }
      const definition = journey()
      const run = journeyRunner.runJourney({
        jobId: 'job',
        suiteId: 'suite',
        trial: trial(),
        journey: {
          ...definition,
          budget: { ...UnlimitedBudget, legs: 1 },
          legs: [{ ...definition.legs[0]!, budget: { ...UnlimitedBudget, [field]: 1 } }],
        },
        driver,
        detectors: createDetectorRegistry(),
        verifiers: passingVerifiers(),
        workspaceRoot: null,
        sourceCommit: null,
        consumerCommit: null,
        now: () => clock.value,
      })
      try {
        await entered
        expect(events).toEqual(['abort-start'])
      } finally {
        releaseAbort()
      }
      const result = await run
      expect(events).toEqual(['abort-start', 'abort-finished', 'closed'])
      expect(result.legs[0]?.settleOutcome).toEqual({ kind: 'budget-exhausted', limit: field })
      expect(result.legs[0]?.criteria[0]?.outcome).toMatchObject({
        kind: 'fail',
        failureClass: 'budget-exhausted',
      })
    }
  })

  test('checks final-only collected usage before verifier success and never clamps a negative token delta', async () => {
    for (const decreasing of [false, true]) {
      const clock = { value: 0 }
      const driver = clockedDriver(clock, 10)
      let sent = false
      let verified = 0
      let closed = 0
      driver.send = async () => {
        sent = true
      }
      driver.waitSettled = async () => {
        clock.value += 10
        return { kind: 'settled' }
      }
      driver.collect = async () =>
        sent
          ? cumulativeObservation(['a', 'b', 'c'], decreasing ? 90 : 50)
          : cumulativeObservation([], decreasing ? 100 : 0)
      driver.closeSession = async () => {
        closed += 1
      }
      const verifiers = createVerifierRegistry()
      verifiers.register('complete', () => {
        verified += 1
        return { kind: 'pass', credit: 1, evidence: {} }
      })
      const definition = journey()
      const result = await journeyRunner.runJourney({
        jobId: 'job',
        suiteId: 'suite',
        trial: trial(),
        journey: {
          ...definition,
          budget: { ...UnlimitedBudget, legs: 1 },
          legs: [{ ...definition.legs[0]!, budget: { toolCalls: 2 } }],
        },
        driver,
        detectors: createDetectorRegistry(),
        verifiers,
        workspaceRoot: null,
        sourceCommit: null,
        consumerCommit: null,
        now: () => clock.value,
      })
      if (decreasing) {
        expect(result.legs[0]?.settleOutcome).toMatchObject({
          kind: 'unavailable',
          cause: 'harness-failure',
          detail: '会话累计 token 不能小于开段基线',
        })
        expect(result.legs[0]?.passed).toBeNull()
      } else {
        expect(result.legs[0]?.settleOutcome).toEqual({
          kind: 'budget-exhausted',
          limit: 'toolCalls',
        })
        expect(result.legs[0]?.criteria[0]?.outcome).toMatchObject({
          kind: 'fail',
          failureClass: 'budget-exhausted',
        })
      }
      expect(verified).toBe(0)
      expect(closed).toBe(1)
      expect(result.manifest.usage.legs).toBe(1)
    }
  })

  test('refuses a new send when the real pre-send baseline already exhausts the journey', async () => {
    const clock = { value: 0 }
    const driver = clockedDriver(clock, 10)
    let sent = 0
    let waited = 0
    let closed = 0
    driver.send = async () => {
      sent += 1
    }
    driver.waitSettled = async () => {
      waited += 1
      return { kind: 'settled' }
    }
    driver.collect = async () => cumulativeObservation(['prepared-a', 'prepared-b'], 50)
    driver.closeSession = async () => {
      closed += 1
    }
    const definition = journey()
    const result = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: { ...definition, budget: { ...UnlimitedBudget, toolCalls: 1, legs: 1 } },
      driver,
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    })
    expect(sent).toBe(0)
    expect(waited).toBe(0)
    expect(closed).toBe(1)
    expect(result.legs[0]?.settleOutcome).toEqual({ kind: 'budget-exhausted', limit: 'toolCalls' })
    expect(result.manifest.usage).toMatchObject({ toolCalls: 2, tokens: 50, workingMs: 0, legs: 1 })

    const nextClock = { value: 0 }
    const cumulative = cumulativeObservation(['a', 'b'], 2)
    const continuing = sampledDriver(
      nextClock,
      [cumulativeObservation([], 0), cumulative, cumulative],
      [
        { toolCalls: 2, tokens: 2, workingMs: 10, wallClockMs: 10, legs: 1 },
        { toolCalls: 0, tokens: 0, workingMs: 10, wallClockMs: 10, legs: 1 },
      ]
    )
    let continuedSends = 0
    continuing.send = async () => {
      continuedSends += 1
    }
    const two = journey('journey-a', 2)
    const stopped = await journeyRunner.runJourney({
      jobId: 'job',
      suiteId: 'suite',
      trial: trial(),
      journey: {
        ...two,
        budget: { ...UnlimitedBudget, toolCalls: 1, legs: 2 },
        legs: [{ ...two.legs[0]!, continueOn: ['budget-exhausted'] }, two.legs[1]!],
      },
      driver: continuing,
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => nextClock.value,
    })
    expect(continuedSends).toBe(1)
    expect(stopped.legs.map((leg) => leg.settleOutcome)).toEqual([
      { kind: 'budget-exhausted', limit: 'toolCalls' },
      { kind: 'budget-exhausted', limit: 'toolCalls' },
    ])
    expect(stopped.manifest.usage.toolCalls).toBe(2)
  })

  test('preserves native failure and verifier facts while gating unapproved final budget exhaustion', async () => {
    const outcomes: SettleOutcome[] = [
      { kind: 'unavailable', cause: 'agent-unavailable', detail: 'native executor unavailable' },
      { kind: 'timeout' },
      { kind: 'aborted', detectorId: 'native-stop', reason: 'native executor stopped' },
    ]
    for (const native of outcomes)
      for (const expectedBudget of [false, true])
        for (const unknown of [false, true]) {
          const clock = { value: 0 }
          const driver = clockedDriver(clock, 10)
          let sent = false
          let verified = 0
          driver.send = async () => {
            sent = true
          }
          driver.waitSettled = async () => {
            clock.value += 10
            return native
          }
          driver.collect = async () =>
            cumulativeObservation(sent ? ['a', 'b', 'c'] : [], sent ? 50 : 0)
          const verifiers = createVerifierRegistry()
          verifiers.register('complete', () => {
            verified += 1
            return unknown
              ? {
                  kind: 'void',
                  cause: 'verifier-unavailable',
                  detail: 'external truth unavailable',
                  evidence: {},
                }
              : { kind: 'pass', credit: 1, evidence: {} }
          })
          const definition = journey()
          const result = await journeyRunner.runJourney({
            jobId: 'job',
            suiteId: 'suite',
            trial: trial(),
            journey: {
              ...definition,
              budget: { ...UnlimitedBudget, legs: 1 },
              legs: [
                {
                  ...definition.legs[0]!,
                  budget: { toolCalls: 2 },
                  continueOn: [native.kind, ...(expectedBudget ? ['budget-exhausted'] : [])],
                },
              ],
            },
            driver,
            detectors: createDetectorRegistry(),
            verifiers,
            workspaceRoot: null,
            sourceCommit: null,
            consumerCommit: null,
            now: () => clock.value,
          })
          expect(verified).toBe(1)
          expect(result.legs[0]?.settleOutcome).toEqual(native)
          expect(result.legs[0]?.criteria[0]?.outcome).toEqual(
            unknown
              ? {
                  kind: 'void',
                  cause: 'verifier-unavailable',
                  detail: 'external truth unavailable',
                  evidence: {},
                }
              : { kind: 'pass', credit: 1, evidence: {} }
          )
          expect(result.legs[0]?.passed).toBe(unknown ? null : expectedBudget)
          expect(result.drops).toEqual(
            unknown
              ? [
                  {
                    trialId: trial().id,
                    legId: definition.legs[0]!.id,
                    cause: 'verifier-unavailable',
                    detail: 'external truth unavailable',
                  },
                ]
              : []
          )
          expect(
            result.findings.find((finding) => finding.detectorId === 'budget-exhausted')
          ).toMatchObject({
            severity: expectedBudget ? 'info' : 'fail',
            failureClass: 'budget-exhausted',
            evidence: { limit: 'toolCalls', nativeOutcome: native.kind },
          })
        }
  })
})

describe('runJob 的失败处理', () => {
  function jobWith(trialCount: number, concurrency: number): JobSpec {
    return {
      id: 'job',
      suiteId: 'suite',
      concurrency,
      archiveDirectory: '/archives',
      trials: Array.from({ length: trialCount }, (_, index) =>
        trial('executor-a', 'journey-a', 'group-a', index + 1)
      ),
    }
  }

  test('一个试验失败后不再派发新试验，也不在后台继续开会话', async () => {
    const started: string[] = []
    const job = jobWith(6, 1)
    await expect(
      journeyRunner.runJob(job, {
        resolveDriver: (candidate) => {
          started.push(candidate.id)
          if (started.length === 2) throw new Error('driver unavailable')
          return clockedDriver({ value: 0 }, 1)
        },
        runTrial: async () => ({ manifest: { trial: { id: 'x' } } }) as unknown as RunArchive,
      })
    ).rejects.toThrow('driver unavailable')

    // 第二个试验失败后，剩下四个一个都没开始。
    expect(started).toHaveLength(2)
  })

  test('并发时等在飞的试验收尾再抛，不留后台会话', async () => {
    const finished: string[] = []
    let releaseSlow: () => void = () => undefined
    const slowTrial = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const job = jobWith(4, 2)

    const run = journeyRunner.runJob(job, {
      resolveDriver: (candidate) => {
        if (candidate.replicate.index === 2) throw new Error('boom')
        return clockedDriver({ value: 0 }, 1)
      },
      runTrial: async (candidate) => {
        if (candidate.replicate.index === 1) await slowTrial
        finished.push(candidate.id)
        return { manifest: { trial: { id: candidate.id } } } as unknown as RunArchive
      },
    })

    // 失败已经发生，但第一个试验还在飞：runJob 必须等它，而不是当场返回。
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toHaveLength(0)
    releaseSlow()
    await expect(run).rejects.toThrow('boom')
    expect(finished).toEqual([job.trials[0]!.id])
  })
})
