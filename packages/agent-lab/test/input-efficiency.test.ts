import { expect, test } from 'bun:test'

import { summarizeToolInputEfficiency } from '../src/workload/InputEfficiency.js'

test('actual attempts remain visible while reused parameters count avoided characters only', () => {
  const receipt = (
    id: string,
    outcome: string,
    requestedChars: number,
    effectiveChars: number,
    reused: boolean
  ) => ({
    toolName: '__tool_attempt_outcome__',
    toolCallId: id,
    serializedResult: JSON.stringify({
      kind: 'tool-attempt-outcome',
      outcome,
      metrics: { requestedChars, effectiveChars, reused },
    }),
  })
  const original = receipt('a', 'not-applied', 10000, 10000, false)
  const repaired = receipt('b', 'completed', 100, 10000, true)
  expect(summarizeToolInputEfficiency([original, repaired, repaired])).toEqual({
    attempts: 2,
    completed: 1,
    notApplied: 1,
    unknown: 0,
    reusedAttempts: 1,
    completedReusedAttempts: 1,
    requestedChars: 10100,
    effectiveChars: 20000,
    avoidedRepeatChars: 9900,
    corruptReceipts: 0,
  })
})
