import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ExecutionRecord } from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'

import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import { ManagedExecutionRunner } from '../src/kernel/execution/ManagedExecutionRunner'

function executionRecord(): ExecutionRecord {
  return {
    id: 'execution-terminal-owner',
    sourceSessionId: 'session-1',
    status: 'pending',
    summary: '',
    resourceId: null,
    createdAt: 1,
    updatedAt: 1,
    roleId: null,
    roleLabel: null,
    roleDescription: null,
    awaitingConfirmation: null,
    awaitingInput: null,
    error: null,
    currentTaskId: 'task-1',
    tasks: [],
    events: [],
  }
}

void describe('ManagedExecutionRunner terminal ownership', () => {
  void test('does not fail an execution already aborted by a runtime event', async () => {
    const execution = executionRecord()
    let failed = 0
    const runner = new ManagedExecutionRunner({
      log: { info: () => undefined, warn: () => undefined },
      records: {
        createExecution: () => execution,
        transition: (_id: string, status: ExecutionRecord['status']) => {
          execution.status = status
          return execution
        },
        startTask: () => undefined,
      } as never,
      sourceSessionGuard: {
        start: () => ({
          abortController: new AbortController(),
          generation: 1,
          supersededExecutionId: null,
        }),
        finish: () => undefined,
      } as never,
      store: {
        setStateListener: () => undefined,
        setDebugListener: () => undefined,
        clearStateListener: () => undefined,
        clearDebugListener: () => undefined,
      } as never,
      executionResource: {} as never,
      activitySignals: { beginExecutionSession: () => () => undefined },
      createToolExecutionApi: () => ({}) as never,
      handleAgentEvent: (_executionId, event) => {
        if (event.type === 'runtime' && event.payload.kind === 'aborted') {
          execution.status = 'aborted'
          execution.error = event.payload.message
        }
      },
      emitExecutionState: () => undefined,
      emitExecutionDebug: () => undefined,
      getExecution: () => execution,
      abortExecution: (_id, reason) => {
        execution.status = 'aborted'
        execution.error = reason
        return execution
      },
      completeExecution: () => {
        execution.status = 'completed'
        return execution
      },
      failExecution: (_id, error) => {
        failed += 1
        execution.status = 'failed'
        execution.error = error
        return execution
      },
      consumeExecutionGuidance: () => null,
      runtimeInputForExecution: () => ({}) as never,
      finalizeExecutionGuidance: () => ({ status: 'sealed' }),
      clearExecutionGuidance: () => ({ status: 'cleared' }),
      isTerminalStatus: (status) =>
        status === 'aborted' || status === 'completed' || status === 'failed',
    })

    await assert.rejects(
      runner.run({
        sourceSessionId: execution.sourceSessionId,
        messages: [],
        events: ExecutionEventBus.noop(),
        run: async ({ events }) => {
          events.emitRuntime(ChatRuntimeEvents.aborted('auth expired'))
          throw new Error('provider stream stopped after abort')
        },
      }),
      /provider stream stopped after abort/u
    )

    assert.equal(execution.status, 'aborted')
    assert.equal(execution.error, 'auth expired')
    assert.equal(failed, 0)
  })
})
