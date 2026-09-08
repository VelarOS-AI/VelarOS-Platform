import { describe, expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { TaskApprovalState } from '../src/agent/TaskApprovalState'
import { ExecutionInteractions } from '../src/execution/Interactions'
import { ExecutionRecords } from '../src/execution/Records'
import { ExecutionRoutingCoordinator } from '../src/execution/routing'
import { ExecutionStateMachine } from '../src/execution/state-machine'
import { ExecutionStore } from '../src/execution/Store'
import type { ApprovalDecision, ToolConfirmationDecisionOptions } from '../src/protocol'
import { type ApprovalPort, createUnattendedSubAgentApprovalPort } from '../src/tool-contract/approval'
import { createApprovalOperationKey, createTaskApprovalPort } from '../src/tool-contract/task-approval'

function harness(decide: (options?: ToolConfirmationDecisionOptions) => ApprovalDecision | Promise<ApprovalDecision>) {
  const tracker = new CodingSessionTracker()
  const cards: ToolConfirmationDecisionOptions[] = []
  const delegate: ApprovalPort = {
    awaitConfirmation: async () => { throw new Error('void entry must use the same decision channel') },
    awaitConfirmationDecision: async (_message, _signal, options) => {
      cards.push(options ?? {})
      return decide(options)
    },
  }
  const port = createTaskApprovalPort(delegate, tracker, {
    shouldAutoApprove: (options) => !options.requireManualApproval
      && tracker.hasConfirmedRiskScope(options.riskScope ?? ''),
  })
  return { tracker, cards, port }
}

const operation = (key: string): ToolConfirmationDecisionOptions => ({
  operation: { key, label: 'Update record', target: key }, approvalRisk: 'high',
})

describe('task approval', () => {
  test('approval views observe grants and revocation immediately from the same owner', () => {
    const state = new TaskApprovalState()
    const tracker = new CodingSessionTracker(undefined, undefined, undefined, undefined, { taskApprovals: state })
    const seen: string[] = []
    const unsubscribe = state.subscribe(() => seen.push(state.list()[0]!.status))
    tracker.recordTaskApproval('A', true, operation('A'))
    tracker.forkForSubAgent().revokeTaskApproval(state.list()[0]!.id)
    expect(seen).toEqual(['approved', 'revoked'])
    expect(state.getRevision()).toBe(2)
    unsubscribe()
  })

  test('a cancelled child waiting behind another confirmation settles without a new card', async () => {
    let finish!: (value: ApprovalDecision) => void
    const h = harness(() => new Promise<ApprovalDecision>((resolve) => { finish = resolve }))
    const parent = h.port.awaitConfirmationDecision('A', undefined, operation('A'))
    const controller = new AbortController()
    const child = h.port.awaitConfirmationDecision('B', controller.signal, operation('B'))
    await Promise.resolve()
    controller.abort()
    await expect(child).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' })
    expect(h.cards).toHaveLength(1)
    finish({ approved: true, message: null })
    await parent
  })
  test('a denial survives another entry and child Agent, and the user can allow a new request', async () => {
    const h = harness((options) => ({ approved: options?.operation?.key !== 'record-A', message: '请改用 dry run' }))
    await expect(h.port.awaitConfirmation('delete A', undefined, operation('record-A'))).rejects.toMatchObject({ code: 'EXECUTION_DENIED', message: '请改用 dry run' })
    const child = createUnattendedSubAgentApprovalPort(h.port)
    expect(await child.awaitConfirmationDecision('different wording and entry', undefined, {
      ...operation('record-A'), riskScope: 'another-tool', approvalRisk: 'low',
    })).toMatchObject({ approved: false, previouslyDenied: true, message: '请改用 dry run' })
    expect(h.cards).toHaveLength(1)
    expect((await h.port.awaitConfirmationDecision('B', undefined, operation('record-B'))).approved).toBe(true)
    const denied = h.tracker.getTaskApprovalRecords().find((record) => record.status === 'denied')!
    expect(h.tracker.revokeTaskApproval(denied.id)).toBe(true)
    await child.awaitConfirmationDecision('A after user revision', undefined, operation('record-A'))
    expect(h.cards).toHaveLength(3)
  })

  test('grants and revocation have one owner across children and continuation trackers', async () => {
    const h = harness(() => ({ approved: true, message: null }))
    await h.port.awaitConfirmation('A', undefined, operation('record-A'))
    await h.port.awaitConfirmation('A again', undefined, operation('record-A'))
    expect(h.cards).toHaveLength(1)
    const child = h.tracker.forkForSubAgent()
    const continuation = new CodingSessionTracker()
    continuation.useTaskApprovalStateFrom(h.tracker)
    expect(child.getTaskApprovalRecords()).toEqual(h.tracker.getTaskApprovalRecords())
    const record = continuation.getTaskApprovalRecords()[0]!
    child.revokeTaskApproval(record.id)
    expect(continuation.hasConfirmedRiskScope('record-A')).toBe(false)
    await h.port.awaitConfirmation('A after revoke', undefined, operation('record-A'))
    expect(h.cards).toHaveLength(2)
    expect(continuation.getTaskApprovalRecords()[0]?.status).toBe('approved')
    expect(JSON.stringify(h.tracker.getTaskApprovalRecords())).not.toContain('operationKey')
  })

  test('unattended child low risk requests obey an ask every time parent policy', async () => {
    let cards = 0
    const parent: ApprovalPort = {
      awaitConfirmation: async () => { cards++ },
      awaitConfirmationDecision: async () => { cards++; return { approved: false, message: 'skip' } },
    }
    const child = createUnattendedSubAgentApprovalPort(parent)
    await child.awaitConfirmation('low risk', undefined, { approvalRisk: 'low' })
    expect((await child.awaitConfirmationDecision('another', undefined, { approvalRisk: 'low' })).approved).toBe(false)
    expect(cards).toBe(2)
  })

  test('manual gates remain once per call and child confirmation respects the parent policy', async () => {
    const h = harness(() => ({ approved: true, message: null }))
    const child = createUnattendedSubAgentApprovalPort(h.port)
    for (let index = 0; index < 2; index++) {
      await child.awaitConfirmation('A', undefined, { ...operation('A'), requireManualApproval: true, approvalRisk: 'low' })
    }
    expect(h.cards).toHaveLength(2)
    expect(h.tracker.getTaskApprovalRecords()).toEqual([])
    expect(h.cards[0]?.detail?.authorization?.scope).toBe('call')
  })

  test('concurrent parent and child requests share a queue and recheck the latest decision', async () => {
    let resolve!: (value: ApprovalDecision) => void
    const h = harness(() => new Promise<ApprovalDecision>((done) => { resolve = done }))
    const first = h.port.awaitConfirmationDecision('A', undefined, operation('A'))
    const second = h.port.awaitConfirmationDecision('A again', undefined, operation('A'))
    await Promise.resolve()
    expect(h.cards).toHaveLength(1)
    resolve({ approved: false, message: 'skip it' })
    await first
    expect(await second).toMatchObject({ approved: false, previouslyDenied: true })
    expect(h.cards).toHaveLength(1)
  })

  test('operation identity ignores object insertion order and preserves complete target values', () => {
    expect(createApprovalOperationKey('shell-command', { cwd: '/work', command: 'rm a' }))
      .toBe(createApprovalOperationKey('shell-command', { command: 'rm a', cwd: '/work' }))
    expect(createApprovalOperationKey('mcp', { target: `${'x'.repeat(5000)}A` }))
      .not.toBe(createApprovalOperationKey('mcp', { target: `${'x'.repeat(5000)}B` }))
  })

  test('legacy void confirmation rejects just the operation and leaves execution running', async () => {
    const records = new ExecutionRecords(new ExecutionStore(), new ExecutionStateMachine(),
      { getActiveResourceId: () => null }, new ExecutionRoutingCoordinator())
    const execution = records.createExecution({ sourceSessionId: 'task', messages: [{ role: 'user', content: 'do work' }] })
    const interactions = new ExecutionInteractions(records, () => undefined, () => undefined)
    const pending = interactions.awaitConfirmation(execution.id, 'modify A')
    interactions.resolveConfirmation(execution.id, false, 'try B', records.getExecution(execution.id).awaitingConfirmation?.confirmationId)
    await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_DENIED' })
    expect(records.getExecution(execution.id).status).toBe('running')
    expect(records.getExecution(execution.id).awaitingConfirmation).toBeNull()
    const next = interactions.awaitConfirmationDecision(execution.id, 'modify B')
    interactions.resolveConfirmation(execution.id, true, undefined, records.getExecution(execution.id).awaitingConfirmation?.confirmationId)
    expect((await next).approved).toBe(true)
    records.transition(execution.id, 'aborted')
    expect(interactions.resolveConfirmation(execution.id, true).status).toBe('aborted')
  })
})
