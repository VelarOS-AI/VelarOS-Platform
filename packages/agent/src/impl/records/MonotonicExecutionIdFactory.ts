import { randomUUID } from 'node:crypto'

import type { ExecutionClock, ExecutionIdFactory } from '../../contract/requires.js'

/**
 * Generates process-local execution identifiers without module-level mutable state.
 *
 * The clock is injectable so hosts and tests can provide deterministic time. Each
 * factory instance owns its counters and a random namespace; independent runtimes
 * neither leak counter state nor collide when they share a clock and persistence
 * namespace.
 */
export class MonotonicExecutionIdFactory implements ExecutionIdFactory {
  /** 缺省时钟：直接读系统时间；宿主与测试可以注入别的。 */
  private static readonly SystemExecutionClock: ExecutionClock = Object.freeze({
    now: () => Date.now(),
  })

  private executionSequence = 0
  private taskSequence = 0
  private planStepSequence = 0

  public constructor(
    private readonly clock: ExecutionClock = MonotonicExecutionIdFactory.SystemExecutionClock,
    private readonly instanceNamespace: string = randomUUID()
  ) {
    if (!instanceNamespace) {
      throw new TypeError('执行 id 的 instanceNamespace 不能是空串：它是同一时钟下区分不同运行时的唯一来源，为空会让两个运行时生成出完全相同的执行 id。')
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
