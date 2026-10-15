import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ExecutionOutputChunk } from '../../system/types/executions.js'
import { ExecutionObservabilityLimits } from '../contract/constants.js'
import type { ExecutionOutputState } from '../types/execution-output.js'
import { appendExecutionOutput } from '../utils/execution-output.js'

import type { ProgramContextApi } from './ProgramContext.js'

/** 输出缓存与持久写合并，完成后释放活跃缓存。 */
export interface ExecutionProgressApi {
  /** 为已经持久受理的作业建立空缓存。 */
  begin(executionId: string): void
  /** 接收过程输出，截断与持久合并均有界。 */
  append(executionId: string, text: string, stream?: ExecutionOutputChunk['stream']): void
  /** 读取活跃缓存，未登记或已结算时返回空。 */
  current(executionId: string): Optional<ExecutionOutputState>
  /** 写完尾部输出并释放活跃缓存。 */
  finish(executionId: string): Promise<void>
  /** 停止计时，等待最后的持久写。 */
  close(): Promise<void>
}

export class ExecutionProgress implements ExecutionProgressApi {
  private readonly buffers = new Map<string, ExecutionOutputState>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private readonly timers = new TimerScope({ name: 'ExecutionProgress' })
  private flushTimer?: TimerLease
  private wakeTimer?: TimerLease
  private closed = false

  public constructor(
    private readonly programs: ProgramContextApi,
    private readonly wake: () => void,
    private readonly failed: (error: unknown) => void
  ) {}

  public begin(executionId: string): void {
    this.buffers.set(executionId, { chunks: [], totalChars: 0 })
  }

  public append(
    executionId: string,
    text: string,
    stream: ExecutionOutputChunk['stream'] = 'combined'
  ): void {
    const current = this.buffers.get(executionId)
    if (this.closed || !current || !text) return
    this.buffers.set(executionId, appendExecutionOutput(current, text, stream))
    this.dirty.add(executionId)
    this.flushTimer ??= this.timers.after(ExecutionObservabilityLimits.flushMs, () => {
      this.flushTimer = undefined
      for (const id of [...this.dirty]) void this.flush(id).catch(this.failed)
    })
    // 输出只能唤醒已经在等待的任务；连续输出合并为每分钟至多一次通知。
    this.wakeTimer ??= this.timers.after(ExecutionObservabilityLimits.wakeMs, () => {
      this.wakeTimer = undefined
      this.wake()
    })
  }

  public current(executionId: string): Optional<ExecutionOutputState> {
    return this.buffers.get(executionId)
  }

  private flush(executionId: string): Promise<void> {
    if (!this.dirty.delete(executionId)) return this.writes.get(executionId) ?? Promise.resolve()
    const output = this.buffers.get(executionId)!
    const write = (this.writes.get(executionId) ?? Promise.resolve()).then(() =>
      this.programs.progress(executionId, output)
    )
    this.writes.set(executionId, write)
    return write
  }

  public async finish(executionId: string): Promise<void> {
    try {
      await this.flush(executionId)
    } finally {
      this.buffers.delete(executionId)
      this.writes.delete(executionId)
    }
  }

  public async close(): Promise<void> {
    this.closed = true
    this.timers.dispose()
    await Promise.all([...this.buffers.keys()].map((id) => this.finish(id)))
  }
}
