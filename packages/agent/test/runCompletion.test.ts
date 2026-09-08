import { describe, expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { buildRunVerificationSummary } from '../src/agent/RunCompletion'

describe('execution completion verification facts', () => {
  test('an ordinary reply does not invent a verification result', () => {
    expect(buildRunVerificationSummary(new CodingSessionTracker().getSnapshot())).toBeUndefined()
  })
  test('code changes with no validation report not-run while a prior pass becomes stale after new edits', () => {
    const snapshot = { ...new CodingSessionTracker().getSnapshot(), hasCapabilityMutations: true, modifiedPaths: ['src/app.ts'], needsVerificationCommand: true }
    expect(buildRunVerificationSummary(snapshot)).toEqual({ status: 'not-run' })
    expect(buildRunVerificationSummary({ ...snapshot, latestVerificationStatus: 'passed' })).toEqual({ status: 'stale' })
    expect(buildRunVerificationSummary({ ...snapshot, latestVerificationStatus: 'passed', needsVerificationCommand: false })).toEqual({ status: 'passed' })
  })
  test('failed validation retains the actual command and issues without upgrading them at normal completion', () => {
    const failure = { status: 'failed' as const, command: 'bun test', issues: ['test failed'] }
    expect(buildRunVerificationSummary({ ...new CodingSessionTracker().getSnapshot(), activeVerificationFailure: failure })).toEqual(failure)
  })
})
