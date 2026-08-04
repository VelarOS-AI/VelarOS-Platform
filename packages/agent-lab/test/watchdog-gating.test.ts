import { describe, expect, test } from 'bun:test'

import {
  createBuiltinDetectors,
  createWatchdogBaseline,
  selectAbortCandidate,
} from '../src/detect/index.js'
import type { DetectorContext, Observation } from '../src/protocol/index.js'

import { journey, observation, trial } from './fixtures.js'

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

describe('watchdog gating', () => {
  test('records non-gating failures without aborting a recoverable run', () => {
    const detectors = createBuiltinDetectors()
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
      retryOnly
    )
    expect(selectAbortCandidate(failedObservation, findings, baseline, retryOnly)).toBeNull()

    const toolFailureGate = new Set(['tool-failure'])
    const gatedBaseline = createWatchdogBaseline(
      baselineObservation,
      baselineFindings,
      toolFailureGate
    )
    expect(
      selectAbortCandidate(failedObservation, findings, gatedBaseline, toolFailureGate)?.detectorId
    ).toBe('tool-failure')
  })
})
