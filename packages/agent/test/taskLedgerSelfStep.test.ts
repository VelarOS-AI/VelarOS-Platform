import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ExecutionTaskPlanStep } from '@velaros-ai/agent/protocol'

import { hasRunningOwnSelfStep } from '../src/execution/task-ledger'

function step(id: string, status: ExecutionTaskPlanStep['status']): ExecutionTaskPlanStep {
  return {
    id,
    title: id,
    roleId: 'primary-agent',
    objective: id,
    kind: 'prepare',
    mode: 'self',
    required: true,
    dependsOn: [],
    actionable: status === 'pending' || status === 'running',
    status,
    taskId: null,
    updatedAt: 1,
    origin: 'manual',
  }
}

describe('execution task ledger self-step progression', () => {
  test('repeated turn refreshes do not start another self step', () => {
    const plan = [step('one', 'completed'), step('two', 'running'), step('three', 'pending')]

    assert.equal(hasRunningOwnSelfStep(plan, 'primary-agent'), true)
  })

  test('the next self step may start after the current one resolves', () => {
    const plan = [step('one', 'completed'), step('two', 'completed'), step('three', 'pending')]

    assert.equal(hasRunningOwnSelfStep(plan, 'primary-agent'), false)
  })
})
