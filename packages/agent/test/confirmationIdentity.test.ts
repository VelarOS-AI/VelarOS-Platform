import { describe, expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { ExecutionInteractions } from '../src/execution/Interactions'
import { ExecutionRecords } from '../src/execution/Records'
import { ExecutionRoutingCoordinator } from '../src/execution/routing'
import { SourceSessionGuard } from '../src/execution/SessionGuard'
import { ExecutionStateMachine } from '../src/execution/state-machine'
import { ExecutionStore } from '../src/execution/Store'
import { ChatKernelSessionBridge } from '../src/kernel/bridge/ChatKernelSessionBridge'
import { ExecutionInteractionFacade } from '../src/kernel/execution/ExecutionInteractionFacade'
import { createUnattendedSubAgentApprovalPort } from '../src/tool-contract/approval'
import { createTaskApprovalPort } from '../src/tool-contract/task-approval'

function harness() {
  const store = new ExecutionStore()
  const records = new ExecutionRecords(store, new ExecutionStateMachine(),
    { getActiveResourceId: () => null }, new ExecutionRoutingCoordinator())
  const execution = records.createExecution({ sourceSessionId: 'task', messages: [{ role: 'user', content: 'do work' }] })
  const interactions = new ExecutionInteractions(records, () => undefined, () => undefined)
  const identity = () => records.getExecution(execution.id).awaitingConfirmation?.confirmationId
  const facade = new ExecutionInteractionFacade(interactions, records, new SourceSessionGuard(), store)
  return { records, execution, interactions, identity, facade }
}

describe('confirmation request identity', () => {
  test('session bridge transports the observed identity through controller and facade', async () => {
    const h = harness()
    const bridge = new ChatKernelSessionBridge({
      executionCoordinator: { run: async () => undefined },
      executionService: {
        abortSourceSession: () => false,
        provideGuidanceForSourceSession: async () => undefined,
        provideInputForSourceSession: (request) => h.facade.provideInputForSourceSession(request),
        resolveConfirmationForSourceSession: (request) => h.facade.resolveConfirmationForSourceSession(request),
        hasPendingInteractionForSourceSession: (id, kind) => h.facade.hasPendingInteractionForSourceSession(id, kind),
        getPendingInteractionForSourceSession: (id, kind) => h.facade.getPendingInteractionForSourceSession(id, kind),
        isRunningForSourceSession: (id) => h.facade.isRunningForSourceSession(id),
      },
    })
    const pending = h.interactions.awaitConfirmationDecision(h.execution.id, 'A')
    const snapshot = h.facade.getPendingInteractionForSourceSession('task', 'confirmation')
    expect(snapshot?.kind).toBe('confirmation')
    if (snapshot?.kind !== 'confirmation') throw new Error('missing live card')
    expect(snapshot.confirmationId).toBe(h.identity())
    await expect(bridge.approve({ sessionId: 'task', approved: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(bridge.approve({ sessionId: 'task', approved: true, confirmationId: 'stale' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await bridge.approve({ sessionId: 'task', approved: false, confirmationId: snapshot.confirmationId, rejectionMessage: 'choose B' })
    expect(await pending).toMatchObject({ approved: false, message: 'choose B' })
  })

  test('missing identity never resolves a live card, and duplicate settled replies are harmless', async () => {
    const h = harness()
    const first = h.interactions.awaitConfirmationDecision(h.execution.id, 'A')
    const id = h.identity()
    expect(() => h.interactions.resolveConfirmation(h.execution.id, true)).toThrow('确认卡片已过期')
    h.interactions.resolveConfirmation(h.execution.id, true, undefined, id)
    expect((await first).approved).toBe(true)
    expect(h.interactions.resolveConfirmation(h.execution.id, false, undefined, id).status).toBe('running')
  })

  test('a cancelled card cannot resolve a resumed request in the same execution', async () => {
    const h = harness()
    const controller = new AbortController()
    const first = h.interactions.awaitConfirmationDecision(h.execution.id, 'A', controller.signal)
    const id = h.identity()
    controller.abort()
    await expect(first).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' })
    const resumed = h.interactions.awaitConfirmationDecision(h.execution.id, 'A resumed')
    expect(() => h.interactions.resolveConfirmation(h.execution.id, true, undefined, id)).toThrow('确认卡片已过期')
    h.interactions.resolveConfirmation(h.execution.id, true, undefined, h.identity())
    expect((await resumed).approved).toBe(true)
  })

  test('parent and child serialized approvals cannot consume each other’s late reply', async () => {
    const h = harness()
    const port = createTaskApprovalPort({
      awaitConfirmation: (message, signal, options) => h.interactions.awaitConfirmation(h.execution.id, message, signal, options),
      awaitConfirmationDecision: (message, signal, options) => h.interactions.awaitConfirmationDecision(h.execution.id, message, signal, options),
    }, new CodingSessionTracker(), { shouldAutoApprove: () => false })
    const first = port.awaitConfirmationDecision('parent A')
    const second = createUnattendedSubAgentApprovalPort(port).awaitConfirmationDecision('child B')
    await Promise.resolve()
    const firstId = h.identity()
    h.interactions.resolveConfirmation(h.execution.id, true, undefined, firstId)
    await first
    for (let tick = 0; tick < 8 && !h.identity(); tick++) await Promise.resolve()
    expect(h.identity()).toBeDefined()
    expect(() => h.interactions.resolveConfirmation(h.execution.id, true, undefined, firstId)).toThrow('确认卡片已过期')
    h.interactions.resolveConfirmation(h.execution.id, false, 'skip child', h.identity())
    expect(await second).toMatchObject({ approved: false, message: 'skip child' })
  })

  test('a late answer for the previous card cannot approve the next operation', async () => {
    const h = harness()
    const first = h.interactions.awaitConfirmationDecision(h.execution.id, 'A')
    const firstId = h.identity()
    h.interactions.resolveConfirmation(h.execution.id, true, undefined, firstId)
    await first
    const second = h.interactions.awaitConfirmationDecision(h.execution.id, 'B')
    const secondId = h.identity()
    expect(() => h.interactions.resolveConfirmation(h.execution.id, true, undefined, firstId))
      .toThrow('确认卡片已过期')
    expect(h.records.getExecution(h.execution.id).status).toBe('awaiting_confirmation')
    expect(secondId).not.toBe(firstId)
    h.interactions.resolveConfirmation(h.execution.id, false, 'skip B', secondId)
    expect(await second).toEqual({ approved: false, message: 'skip B' })
  })
})
