import { describe, expect, test } from 'bun:test'

import {
  type ExecutionClock,
  MonotonicExecutionIdFactory,
} from '../src/execution'

class FixedClock implements ExecutionClock {
  public constructor(private readonly timestamp: number) {}

  public now(): number {
    return this.timestamp
  }
}

describe('MonotonicExecutionIdFactory', () => {
  test('keeps identifiers unique and sequences isolated per runtime instance', () => {
    const first = new MonotonicExecutionIdFactory(new FixedClock(42), 'runtime-a')
    const second = new MonotonicExecutionIdFactory(new FixedClock(42), 'runtime-b')

    expect(first.createExecutionId()).toBe('execution-42-runtime-a-1')
    expect(first.createExecutionId()).toBe('execution-42-runtime-a-2')
    expect(second.createExecutionId()).toBe('execution-42-runtime-b-1')
  })

  test('uses independent namespaces for execution, task, and plan identifiers', () => {
    const factory = new MonotonicExecutionIdFactory(new FixedClock(7), 'runtime')

    expect(factory.createExecutionId()).toBe('execution-7-runtime-1')
    expect(factory.createTaskId()).toBe('execution-task-7-runtime-1')
    expect(factory.createPlanStepId()).toBe('manual-plan-7-runtime-1')
  })

  test('rejects an empty runtime namespace', () => {
    expect(() => new MonotonicExecutionIdFactory(new FixedClock(7), '')).toThrow(
      'namespace must not be empty'
    )
  })
})
