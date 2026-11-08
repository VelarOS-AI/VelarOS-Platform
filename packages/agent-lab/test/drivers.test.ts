import { expect, test } from 'bun:test'

import { FullCapabilities, journey, observation, trial } from '../spec/support.js'
import type { NativeExecutionState, PollingDriverAdapter, SessionHandle } from '../src/index.js'
import {
  createDetectorRegistry,
  createVerifierRegistry,
  EmptyBudgetUsage,
  journeyRunner,
  labDrivers,
  UnlimitedBudget,
} from '../src/index.js'

const Policy = { pollMs: 1, settlePolls: 2, defaultWallClockMs: 1_000 }
const Session: SessionHandle = {
  id: 'native-session',
  executorId: 'executor-a',
  externalId: 'native',
  metadata: {},
}

function adapter(overrides: Partial<PollingDriverAdapter> = {}): PollingDriverAdapter {
  return {
    id: 'native',
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
    openSession: async () => Session,
    prepare: async () => undefined,
    send: async () => undefined,
    readState: async () => ({
      running: false,
      awaitingConfirmation: false,
      awaitingInput: false,
      revision: 'initial',
      usage: EmptyBudgetUsage,
      unavailable: null,
    }),
    collect: async (_session, phase) => observation(phase),
    abort: async () => undefined,
    closeSession: async () => undefined,
    ...overrides,
  }
}

function sessionSpec() {
  return { trial: trial(), journey: journey(), workspaceRoot: null }
}

test('polling driver requires executor-native progress and stable idle', async () => {
  const states: NativeExecutionState[] = [
    { running: false, revision: 'old' },
    { running: true, revision: 'old' },
    { running: false, revision: 'new' },
    { running: false, revision: 'new' },
  ].map((state) => ({
    ...state,
    awaitingConfirmation: false,
    awaitingInput: false,
    usage: EmptyBudgetUsage,
    unavailable: null,
  }))
  let cursor = 0
  const driver = labDrivers.createPolling(
    adapter({ readState: async () => states[Math.min(cursor++, states.length - 1)] }),
    Policy
  )
  const session = await driver.openSession(sessionSpec())
  await driver.send(session, journey().legs[0])
  const outcome = await driver.waitSettled(session, {
    budget: { ...UnlimitedBudget, wallClockMs: 1_000 },
    signal: new AbortController().signal,
    onSample: async () => ({ kind: 'continue' }),
  })
  expect(outcome.kind).toBe('settled')
  await driver.closeSession(session)
})

test('polling driver classifies native executor unavailability as attrition', async () => {
  const driver = labDrivers.createPolling(
    adapter({
      id: 'native-unavailable',
      readState: async () => ({
        running: false,
        awaitingConfirmation: false,
        awaitingInput: false,
        revision: 'error',
        usage: EmptyBudgetUsage,
        unavailable: { detail: 'authentication_failed' },
      }),
    }),
    Policy
  )
  const session = await driver.openSession(sessionSpec())
  const outcome = await driver.waitSettled(session, {
    budget: { ...UnlimitedBudget, wallClockMs: 1_000 },
    signal: new AbortController().signal,
    onSample: async () => ({ kind: 'continue' }),
  })
  expect(outcome).toEqual({
    kind: 'unavailable',
    cause: 'agent-unavailable',
    detail: 'authentication_failed',
  })
  await driver.closeSession(session)
})

test('opening failure before acquisition does not close a session the driver never acquired', async () => {
  const failure = new Error('native open failed')
  const closed: SessionHandle[] = []
  const driver = labDrivers.createPolling(
    adapter({
      openSession: async () => {
        throw failure
      },
      closeSession: async (session) => {
        closed.push(session)
      },
    }),
    Policy
  )
  await expect(driver.openSession(sessionSpec())).rejects.toBe(failure)
  expect(closed).toEqual([])
})

test('the acquired native session closes exactly once when its first state read fails', async () => {
  const failure = new Error('native state read failed')
  const closed: SessionHandle[] = []
  const driver = labDrivers.createPolling(
    adapter({
      readState: async () => {
        throw failure
      },
      closeSession: async (session) => {
        closed.push(session)
      },
    }),
    Policy
  )
  await expect(driver.openSession(sessionSpec())).rejects.toBe(failure)
  expect(closed).toEqual([Session])
})

test('failed initial read and failed release retain both errors through the journey boundary', async () => {
  const readFailure = new Error('native initial state is unreadable')
  const closeFailure = new Error('native release failed')
  let closed = 0
  const driver = labDrivers.createPolling(
    adapter({
      readState: async () => {
        throw readFailure
      },
      closeSession: async () => {
        closed += 1
        throw closeFailure
      },
    }),
    Policy
  )
  const error: unknown = await driver
    .openSession(sessionSpec())
    .catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(AggregateError)
  if (error instanceof AggregateError) {
    expect(error.cause).toBe(readFailure)
    expect(error.errors).toEqual([readFailure, closeFailure])
    expect(error.message).toContain(readFailure.message)
    expect(error.message).toContain(closeFailure.message)
  }
  expect(closed).toBe(1)

  const verifiers = createVerifierRegistry()
  verifiers.register('complete', () => ({ kind: 'pass', credit: 1, evidence: {} }))
  const archive = await journeyRunner.runJourney({
    jobId: 'job',
    suiteId: 'suite',
    trial: trial(),
    journey: journey(),
    driver,
    detectors: createDetectorRegistry(),
    verifiers,
    workspaceRoot: null,
    sourceCommit: null,
    consumerCommit: null,
  })
  expect(closed).toBe(2)
  expect(archive.legs).toHaveLength(0)
  expect(archive.drops).toHaveLength(1)
  expect(archive.drops[0]?.detail).toContain(readFailure.message)
  expect(archive.drops[0]?.detail).toContain(closeFailure.message)
})

test('successful initial sampling transfers the live session to the caller until its explicit close', async () => {
  const closed: SessionHandle[] = []
  const driver = labDrivers.createPolling(
    adapter({
      closeSession: async (session) => {
        closed.push(session)
      },
    }),
    Policy
  )
  const session = await driver.openSession(sessionSpec())
  expect(session).toBe(Session)
  expect(closed).toEqual([])
  await driver.closeSession(session)
  expect(closed).toEqual([Session])
})
