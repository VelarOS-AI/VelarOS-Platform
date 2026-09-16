import { describe, expect, test } from 'bun:test'

import type { DetectorContext, Observation, ToolCallRecord } from '../src/exports/index.js'
import { DefaultLoopThresholds } from '../src/exports/index.js'
import { createBuiltinDetectors } from '../src/utils/measure/detectors.js'
import { createWatchdogBaseline, selectAbortCandidate } from '../src/utils/measure/watchdog.js'

/** 宿主给的两份工具名单加缺省阈值；本包核心里不写任何产品的工具名。 */
const settings = {
  thresholds: DefaultLoopThresholds,
  catalogToolNames: ['tooling:map'],
  interactiveToolNames: ['interaction:ask_user'],
}

import { journey, observation, trial } from '../spec/support.js'

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

describe('watchdog gating', () => {
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
    expect(selectAbortCandidate(failedObservation, findings, baseline, retryOnly, settings)).toBeNull()

    const toolFailureGate = new Set(['tool-failure'])
    const gatedBaseline = createWatchdogBaseline(
      baselineObservation,
      baselineFindings,
      toolFailureGate,
      settings
    )
    expect(
      selectAbortCandidate(failedObservation, findings, gatedBaseline, toolFailureGate, settings)?.detectorId
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
