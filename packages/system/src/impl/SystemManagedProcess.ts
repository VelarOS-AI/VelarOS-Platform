/**
 * 单个受管子进程：`SystemManagedProcess`。接口见 `contract/commands.ts` 的 `ManagedSystemProcess`。
 * 由 `SystemProcessManager.manage` 创建；从启动、退出、管道排空到有界终止都由它收尾，登记表通过 hooks 知道它的 pid 和收尾时刻。
 */

import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { isNumber } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { SystemProcessCompletion } from '../contract/commands.js'
import type { ManagedSystemProcess, SystemManagedProcessHooks, SystemProcessLifecycleOptions } from '../interface/internal.js'
import { terminateSystemProcessTree } from '../utils/process.js'

export class SystemManagedProcess implements ManagedSystemProcess {
  public readonly identity = `managed:${randomUUID()}`
  public readonly child: ChildProcess
  public readonly completion: Promise<SystemProcessCompletion>
  public result: Nullable<SystemProcessCompletion> = null
  public exited = false
  private complete!: (result: SystemProcessCompletion) => void
  private timedOut = false
  private aborted = false
  private stopping = false
  private finished = false
  private exitCode: Nullable<number> = null
  private signal: Nullable<string> = null
  private readonly timers = new TimerScope({ name: 'ManagedSystemProcess' })
  private readonly platform: NodeJS.Platform
  private readonly options: SystemProcessLifecycleOptions
  private readonly hooks: SystemManagedProcessHooks
  private readonly onAbort = (): void => {
    this.aborted = true
    this.requestStop()
  }

  constructor(
    child: ChildProcess,
    options: SystemProcessLifecycleOptions,
    hooks: SystemManagedProcessHooks
  ) {
    this.child = child
    this.options = options
    this.hooks = hooks
    this.platform = options.platform ?? process.platform
    this.completion = new Promise<SystemProcessCompletion>((resolve) => {
      this.complete = resolve
    })
    hooks.track(this)
    child.once('spawn', () => hooks.track(this))
    child.once('exit', (code, exitSignal) => {
      this.exited = true
      this.exitCode = code
      this.signal = exitSignal
      // 根进程可能先于后代退出；只要后代仍存活，该进程组就仍由这里负责。
      if (this.platform !== 'win32' && child.pid)
        void terminateSystemProcessTree(child.pid, 'SIGKILL', { platform: this.platform })
      // 后代进程可能在直接子进程退出后继续持有继承的管道句柄。
      this.later(() => this.finish(null, true), options.drainTimeoutMs ?? 1_000)
    })
    child.once('close', (code, exitSignal) => {
      this.exited = true
      this.exitCode = code
      this.signal = exitSignal
      this.finish()
    })
    child.on('error', (error) => {
      this.exited = true
      this.finish(error)
    })
    if (isNumber(options.timeoutMs))
      this.later(() => {
        this.timedOut = true
        this.requestStop()
      }, options.timeoutMs)
    if (options.abortSignal?.aborted) this.onAbort()
    else options.abortSignal?.addEventListener('abort', this.onAbort, { once: true })
  }

  public async stop(requestedSignal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
    // 根进程退出后，后代继承的管道与清理回执仍可能尚未结束。
    if (this.exited) {
      const result = this.result ?? (await this.completion)
      return !result.cleanupIncomplete
    }
    if (this.finished) {
      const retryTimers = new TimerScope({ name: 'SystemProcessStopRetry' })
      try {
        await retryTimers.withTimeout(this.options.terminationDeadlineMs ?? 5_000, () => this.terminate(requestedSignal))
      } catch {
        // arch-guard:silent-catch-ok 重试结果只由已观察到的进程退出事实决定。
      } finally {
        retryTimers.dispose()
      }
      return this.exited
    }
    this.requestStop(requestedSignal)
    const result = await this.completion
    return !result.cleanupIncomplete && this.exited
  }

  /** 收尾：只做一次。停掉计时器、放开管道，写下回执并兑现 completion。 */
  private finish(spawnError: Nullable<Error> = null, cleanupIncomplete = false): void {
    if (this.finished) return
    this.finished = true
    this.timers.dispose()
    this.options.abortSignal?.removeEventListener('abort', this.onAbort)
    this.child.stdin?.destroy()
    if (cleanupIncomplete) {
      this.child.stdout?.destroy()
      this.child.stderr?.destroy()
      this.child.unref()
    }
    const result: SystemProcessCompletion = {
      exitCode: this.exitCode,
      signal: this.signal,
      timedOut: this.timedOut,
      aborted: this.aborted,
      spawnError,
      cleanupIncomplete,
    }
    this.result = result
    this.complete(result)
    this.hooks.onFinished()
  }

  /** 发起终止，只发一次：先发给定信号，宽限期后补 SIGKILL，终止期限到了仍没收尾就按 cleanupIncomplete 收尾。 */
  private requestStop(requestedSignal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.stopping || this.finished) return
    this.stopping = true
    this.later(() => this.finish(null, true), this.options.terminationDeadlineMs ?? 5_000)
    void this.kill(requestedSignal)
    if (requestedSignal !== 'SIGKILL')
      this.later(() => {
        void this.kill('SIGKILL')
      }, this.options.terminateGraceMs ?? 500)
  }

  /** 进程还在时发一次信号；失败不抛，结果交给 completion 如实反映。 */
  private async kill(requestedSignal: NodeJS.Signals): Promise<void> {
    if (this.exited || this.finished) return
    try {
      await this.terminate(requestedSignal)
    } catch {
      // arch-guard:silent-catch-ok 有界清理无法确认时，由 completion 返回 cleanupIncomplete。
    }
  }

  /** 终止整棵进程树：调用方给了 terminate 就用它，否则按平台终止。 */
  private terminate(requestedSignal: NodeJS.Signals): Promise<unknown> {
    return this.options.terminate?.(requestedSignal)
      ?? terminateSystemProcessTree(this.child.pid ?? 0, requestedSignal, { platform: this.platform })
  }

  /** 还没收尾时才排定一个延时动作。 */
  private later(callback: () => void, delay: number): void {
    if (!this.finished) this.timers.after(delay, callback)
  }
}
