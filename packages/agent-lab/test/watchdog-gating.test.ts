import { describe, expect, test } from 'bun:test'

import type { DetectorContext, LabDriver, Observation, ToolCallRecord } from '../src/index.js'
import {
  createDetectorRegistry,
  createVerifierRegistry,
  DefaultLoopThresholds,
  EmptyBudgetUsage,
  journeyRunner,
  UnlimitedBudget,
} from '../src/index.js'
import { createBuiltinDetectors } from '../src/utils/measure/detectors.js'
import { createWatchdogBaseline, selectAbortCandidate } from '../src/utils/measure/watchdog.js'

/** 宿主给的两份工具名单加缺省阈值；本包核心里不写任何产品的工具名。 */
const settings = {
  thresholds: DefaultLoopThresholds,
  catalogToolNames: ['tooling:map'],
  interactiveToolNames: ['interaction:ask_user'],
}

import { FullCapabilities, journey, observation, trial } from '../spec/support.js'

const context: DetectorContext = {
  trial: trial(),
  journey: journey(),
  leg: null,
}

function withValidationFailure(): Observation {
  return {
    ...observation(),
    turns: [
      {
        id: 'turn-1',
        index: 1,
        finishReasons: [],
        toolCalls: [
          {
            id: 'call-1',
            turnId: 'turn-1',
            name: 'project:read',
            input: { files: ['src/index.ts'] },
            result: { type: 'error-text', value: 'schema_validation_failed' },
            isError: true,
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      },
    ],
  }
}

function withCalls(names: readonly string[]): Observation {
  return {
    ...observation(),
    turns: [
      {
        id: 'turn-1',
        index: 1,
        finishReasons: [],
        toolCalls: names.map((name, index): ToolCallRecord => ({
          id: `call-${index}`,
          turnId: 'turn-1',
          name,
          input: name === 'browser:inspect_page' ? { maxElements: 120 } : { ref: `@e${index}` },
          result: { ok: true },
          isError: false,
          startedAt: index * 2,
          finishedAt: index * 2 + 1,
        })),
      },
    ],
  }
}

function call(id: string, input: ToolCallRecord['input'], name = 'project:read'): ToolCallRecord {
  return {
    id,
    turnId: 'turn-1',
    name,
    input,
    result: { ok: true },
    isError: false,
    startedAt: null,
    finishedAt: null,
  }
}

function withToolCalls(calls: readonly ToolCallRecord[]): Observation {
  return {
    ...observation(),
    usage: null,
    turns: [{ id: 'turn-1', index: 1, finishReasons: [], toolCalls: calls }],
  }
}

function inspectWindow(before: Observation, current: Observation, activeIds: readonly string[]) {
  const detectors = createDetectorRegistry()
  detectors.registerBuiltins(settings)
  const active = new Set(activeIds)
  const baseline = detectors.watchdogBaseline(before, detectors.detect(before, context), active)
  const findings = detectors.detect(current, context)
  return { baseline, findings, abort: detectors.watchdogAbort(current, findings, baseline, active) }
}

async function runWindow(before: Observation, current: Observation, activeIds: readonly string[]) {
  const detectors = createDetectorRegistry()
  detectors.registerBuiltins(settings)
  const verifiers = createVerifierRegistry()
  verifiers.register('complete', () => ({ kind: 'pass', credit: 1, evidence: {} }))
  const session = { id: 'session', executorId: 'executor-a', externalId: 'native', metadata: {} }
  const events: string[] = []
  let sent = false
  const driver: LabDriver = {
    id: 'window-fixture',
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
    send: async () => {
      sent = true
      events.push('send')
    },
    collect: async (_session, phase) => ({ ...(sent ? current : before), phase }),
    waitSettled: async (_session, request) => {
      events.push('sample')
      const decision = await request.onSample({
        observation: { ...current, phase: 'running' },
        usage: EmptyBudgetUsage,
      })
      return decision.kind === 'abort'
        ? { kind: 'aborted', detectorId: decision.detectorId, reason: decision.reason }
        : { kind: 'settled' }
    },
    abort: async () => {
      events.push('abort')
    },
    closeSession: async () => {
      events.push('close')
    },
  }
  const definition = journey()
  const archive = await journeyRunner.runJourney({
    jobId: 'job',
    suiteId: 'suite',
    trial: trial(),
    journey: {
      ...definition,
      gatingDetectorIds: activeIds,
      budget: { ...UnlimitedBudget, legs: 1 },
    },
    driver,
    detectors,
    verifiers,
    workspaceRoot: null,
    sourceCommit: null,
    consumerCommit: null,
  })
  return { archive, events }
}

describe('watchdog gating', () => {
  test('shares known retry and catalog page identities between diagnostics and active abort gates', () => {
    const empty = withToolCalls([])
    const retryCount = DefaultLoopThresholds.retryAbort
    for (const input of [null, {}]) {
      const current = withToolCalls(
        Array.from({ length: retryCount }, (_, index) => call(`empty-${index}`, input))
      )
      const checked = inspectWindow(empty, current, ['tool-retry-loop'])
      expect(checked.findings.some((finding) => finding.detectorId === 'tool-retry-loop')).toBe(
        false
      )
      expect(checked.abort).toBeNull()
    }
    const half = Math.ceil(retryCount / 2)
    const reset = withToolCalls([
      ...Array.from({ length: half }, (_, index) => call(`before-${index}`, { path: '/a' })),
      call('unknown', null),
      ...Array.from({ length: half }, (_, index) => call(`after-${index}`, { path: '/a' })),
    ])
    expect(inspectWindow(empty, reset, ['tool-retry-loop']).abort).toBeNull()

    const count = DefaultLoopThresholds.toolMapReadAbort
    const finds = withToolCalls(
      Array.from({ length: retryCount }, (_, index) =>
        call(`find-${index}`, { op: 'find', query: 'write' }, 'tooling:map')
      )
    )
    const findCheck = inspectWindow(empty, finds, ['toolmap-read-loop'])
    expect(findCheck.findings.some((finding) => finding.detectorId === 'toolmap-read-loop')).toBe(
      false
    )
    expect(findCheck.abort).toBeNull()
    expect(inspectWindow(empty, finds, ['tool-retry-loop']).abort?.detectorId).toBe(
      'tool-retry-loop'
    )

    const reads = withToolCalls(
      Array.from({ length: count }, (_, index) =>
        call(`read-${index}`, { op: 'read', ids: ['tool:write'], incidental: index }, 'tooling:map')
      )
    )
    const readCheck = inspectWindow(empty, reads, ['toolmap-read-loop'])
    expect(
      readCheck.findings.find((finding) => finding.detectorId === 'toolmap-read-loop')?.evidence
        .count
    ).toBe(count)
    expect(readCheck.abort?.detectorId).toBe('toolmap-read-loop')
    const distinct = withToolCalls(
      Array.from({ length: count }, (_, index) =>
        call(`page-${index}`, { op: 'read', ids: [`tool:${index}`] }, 'tooling:map')
      )
    )
    expect(inspectWindow(empty, distinct, ['toolmap-read-loop']).abort).toBeNull()

    const shared = call('shared-call', { path: '/a' })
    const duplicates: Observation = {
      ...empty,
      turns: Array.from({ length: retryCount }, (_, index) => ({
        id: `turn-${index}`,
        index,
        finishReasons: [],
        toolCalls: [{ ...shared, turnId: `turn-${index}` }],
      })),
    }
    const duplicateCheck = inspectWindow(empty, duplicates, ['tool-retry-loop'])
    expect(
      duplicateCheck.findings.some((finding) => finding.detectorId === 'tool-retry-loop')
    ).toBe(false)
    expect(duplicateCheck.abort).toBeNull()
  })

  test('separates a new same-argument episode from a continued historical prefix', () => {
    const count = DefaultLoopThresholds.retryAbort
    const old = Array.from({ length: count }, (_, index) => call(`old-${index}`, { path: '/a' }))
    const before = withToolCalls(old)
    expect(inspectWindow(before, before, ['tool-retry-loop']).abort).toBeNull()
    const continued = Array.from({ length: count }, (_, index) =>
      call(`continued-${index}`, { path: '/a' })
    )
    expect(
      inspectWindow(before, withToolCalls([...old, ...continued.slice(0, -1)]), ['tool-retry-loop'])
        .abort
    ).toBeNull()
    expect(
      inspectWindow(before, withToolCalls([...old, ...continued]), ['tool-retry-loop']).abort
        ?.detectorId
    ).toBe('tool-retry-loop')
    const restarted = withToolCalls([
      ...old,
      call('separator', { path: '/b' }, 'project:write'),
      ...continued,
    ])
    expect(inspectWindow(before, restarted, ['tool-retry-loop']).abort?.detectorId).toBe(
      'tool-retry-loop'
    )
  })

  test('does not infer an empty history from missing or partial counter coverage', () => {
    const current = withToolCalls(
      Array.from({ length: DefaultLoopThresholds.retryAbort }, (_, index) =>
        call(`old-${index}`, { path: '/a' })
      )
    )
    for (const coverage of ['none', 'partial'] as const) {
      const before = { ...current, coverage: { ...current.coverage, turns: coverage } }
      const checked = inspectWindow(before, current, ['tool-retry-loop'])
      expect(checked.baseline.counts).toBeNull()
      expect(checked.abort).toBeNull()
      expect(inspectWindow(withToolCalls([]), before, ['tool-retry-loop']).abort).toBeNull()
      const failed = withValidationFailure()
      expect(inspectWindow(before, failed, ['tool-failure']).abort?.detectorId).toBe('tool-failure')
    }
  })

  test('runner aborts new retries present in the first sample and preserves actual close ordering', async () => {
    const count = DefaultLoopThresholds.retryAbort
    const old = Array.from({ length: count }, (_, index) => call(`old-${index}`, { path: '/a' }))
    const fresh = Array.from({ length: count }, (_, index) => call(`new-${index}`, { path: '/a' }))
    for (const [before, current] of [
      [withToolCalls([]), withToolCalls(fresh)],
      [
        withToolCalls(old),
        withToolCalls([...old, call('separator', { path: '/b' }, 'project:write'), ...fresh]),
      ],
    ]) {
      const checked = await runWindow(before!, current!, ['tool-retry-loop'])
      expect(checked.archive.legs[0]?.settleOutcome).toMatchObject({
        kind: 'aborted',
        detectorId: 'tool-retry-loop',
      })
      expect(checked.events).toEqual(['send', 'sample', 'abort', 'close'])
    }
    const unchanged = await runWindow(withToolCalls(old), withToolCalls(old), ['tool-retry-loop'])
    expect(unchanged.archive.legs[0]?.settleOutcome.kind).toBe('settled')
    expect(unchanged.events).toEqual(['send', 'sample', 'close'])
    const ungated = await runWindow(withToolCalls([]), withToolCalls(fresh), [])
    expect(ungated.archive.legs[0]?.settleOutcome.kind).toBe('settled')
    expect(ungated.events).toEqual(['send', 'sample', 'close'])
  })

  test('runner does not kill old history that becomes visible after an unknown pre-send observation', async () => {
    const current = withToolCalls(
      Array.from({ length: DefaultLoopThresholds.retryAbort }, (_, index) =>
        call(`old-${index}`, { path: '/a' })
      )
    )
    for (const coverage of ['none', 'partial'] as const) {
      const checked = await runWindow(
        { ...current, coverage: { ...current.coverage, turns: coverage } },
        current,
        ['tool-retry-loop']
      )
      expect(checked.archive.legs[0]?.settleOutcome.kind).toBe('settled')
      expect(checked.events).toEqual(['send', 'sample', 'close'])
    }
  })

  test('records non-gating failures without aborting a recoverable run', () => {
    const detectors = createBuiltinDetectors(settings)
    const baselineObservation = observation()
    const baselineFindings = detectors.flatMap((detector) =>
      detector.detect(baselineObservation, context)
    )
    const failedObservation = withValidationFailure()
    const findings = detectors.flatMap((detector) => detector.detect(failedObservation, context))
    expect(findings.some((finding) => finding.detectorId === 'tool-failure')).toBe(true)

    const retryOnly = new Set(['tool-retry-loop'])
    const baseline = createWatchdogBaseline(
      baselineObservation,
      baselineFindings,
      retryOnly,
      settings
    )
    expect(
      selectAbortCandidate(failedObservation, findings, baseline, retryOnly, settings)
    ).toBeNull()

    const toolFailureGate = new Set(['tool-failure'])
    const gatedBaseline = createWatchdogBaseline(
      baselineObservation,
      baselineFindings,
      toolFailureGate,
      settings
    )
    expect(
      selectAbortCandidate(failedObservation, findings, gatedBaseline, toolFailureGate, settings)
        ?.detectorId
    ).toBe('tool-failure')
  })

  test('does not abort legitimate repeated reads separated by page mutations', () => {
    const retryOnly = new Set(['tool-retry-loop'])
    const baselineObservation = observation()
    const baseline = createWatchdogBaseline(baselineObservation, [], retryOnly, settings)
    const detectors = createBuiltinDetectors(settings)
    const interleaved = withCalls(
      Array.from({ length: 6 }, () => ['browser:inspect_page', 'browser:act']).flat()
    )
    expect(selectAbortCandidate(interleaved, [], baseline, retryOnly, settings)).toBeNull()
    expect(
      detectors
        .flatMap((detector) => detector.detect(interleaved, context))
        .some((finding) => finding.detectorId === 'tool-retry-loop')
    ).toBe(false)

    const consecutive = withCalls(Array.from({ length: 6 }, () => 'browser:inspect_page'))
    expect(selectAbortCandidate(consecutive, [], baseline, retryOnly, settings)?.detectorId).toBe(
      'tool-retry-loop'
    )
    expect(
      detectors
        .flatMap((detector) => detector.detect(consecutive, context))
        .some((finding) => finding.detectorId === 'tool-retry-loop')
    ).toBe(true)
  })
})
