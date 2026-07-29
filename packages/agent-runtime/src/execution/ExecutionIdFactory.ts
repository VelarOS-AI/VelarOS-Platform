import { randomUUID } from 'node:crypto'

export interface ExecutionClock {
  now(): number
}

export interface ExecutionIdFactory {
  createExecutionId(): string
  createTaskId(): string
  createPlanStepId(): string
}

const SystemExecutionClock: ExecutionClock = Object.freeze({
  now: () => Date.now(),
})

/**
 * Generates process-local execution identifiers without module-level mutable state.
 *
 * The clock is injectable so hosts and tests can provide deterministic time. Each
 * factory instance owns its counters and a random namespace; independent runtimes
 * neither leak counter state nor collide when they share a clock and persistence
 * namespace.
 */
export class MonotonicExecutionIdFactory implements ExecutionIdFactory {
  private executionSequence = 0
  private taskSequence = 0
  private planStepSequence = 0

  public constructor(
    private readonly clock: ExecutionClock = SystemExecutionClock,
    private readonly instanceNamespace: string = randomUUID()
  ) {
    if (!instanceNamespace) {
      throw new TypeError('Execution ID namespace must not be empty')
    }
  }

  public createExecutionId(): string {
    this.executionSequence += 1
    return this.format('execution', this.executionSequence)
  }

  public createTaskId(): string {
    this.taskSequence += 1
    return this.format('execution-task', this.taskSequence)
  }

  public createPlanStepId(): string {
    this.planStepSequence += 1
    return this.format('manual-plan', this.planStepSequence)
  }

  private format(namespace: string, sequence: number): string {
    return `${namespace}-${this.clock.now()}-${this.instanceNamespace}-${sequence}`
  }
}
