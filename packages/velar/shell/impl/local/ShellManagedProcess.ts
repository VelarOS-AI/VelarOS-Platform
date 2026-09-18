/**
 * 单个受管子进程：`ShellManagedProcess`。接口 `ManagedShellProcess`、登记表回调 `ShellManagedProcessHooks` 与收尾策略 `ShellManagedProcessLifecycleOptions` 都在本文件的类上方。
 * 由 `ShellProcessManager.manage` 创建；从启动、退出、管道排空到有界终止都由它收尾，登记表通过 hooks 知道它的 pid 和收尾时刻。
 */

import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { isNumber } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ShellProcessCompletion } from '../../types/local.js'
import { terminateProcessTree } from '../../utils/process.js'
import { ShellTuning } from '../../utils/tuning.js'

/** 一个受管子进程，由 `ShellProcessManagerApi.manage` 返回。 */
export interface ManagedShellProcess {
  /** 受管身份，形如 `managed:<uuid>`；后台任务靠它确认进程还是不是自己启动的那个。 */
  identity: string
  /** 被管理的子进程本身。 */
  child: ChildProcess
  /** 进程彻底收尾时兑现，只兑现一次：退出且管道排空，或者期限到了放弃等待。 */
  completion: Promise<ShellProcessCompletion>
  /** 收尾结果；还没收尾时是 null。 */
  result: Nullable<ShellProcessCompletion>
  /** 直接子进程是否已经退出。后代可能还占着管道，这时 result 仍可能是 null。 */
  exited: boolean
  /**
   * 请求终止并等结果：先发给定信号（默认 SIGTERM），宽限期后补 SIGKILL。
   * 返回 true 表示确认已退出且收尾完整；已经退出的进程直接按收尾结果回答。
   */
  stop: (signal?: NodeJS.Signals) => Promise<boolean>
}

/** 受管进程向登记表回报的两个时刻，由登记表在创建受管进程时给。 */
export interface ShellManagedProcessHooks {
  /** 子进程有了 pid（创建时或 spawn 事件时）就回报一次，登记表据此按 pid 登记。 */
  track: (managed: ManagedShellProcess) => void
  /** 进程收尾后回报，登记表据此清理过多的结束回执。 */
  onFinished: () => void
}

/** 接管子进程时的收尾策略。 */
export interface ShellManagedProcessLifecycleOptions {
  /** 按哪个平台终止进程树；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /** 超时毫秒数，到了就开始终止；不给就不限时。 */
  timeoutMs?: number
  /** 取消信号，触发后开始终止。 */
  abortSignal?: AbortSignal
  /** 直接子进程退出后，等后代放开管道的最长毫秒数；不给用 ShellTuning.process.drainTimeoutMs。 */
  drainTimeoutMs?: number
  /** 发出终止信号后，补发 SIGKILL 之前的宽限毫秒数；不给用 ShellTuning.process.terminateGraceMs。 */
  terminateGraceMs?: number
  /** 从开始终止到放弃等待、按 cleanupIncomplete 收尾的最长毫秒数；不给用 ShellTuning.process.terminationDeadlineMs。 */
  terminationDeadlineMs?: number
  /** 自定义终止方式；不给就按平台终止整棵进程树。 */
  terminate?: (signal: NodeJS.Signals) => Promise<boolean>
}

export class ShellManagedProcess implements ManagedShellProcess {
  public readonly identity = `managed:${randomUUID()}`
  public readonly child: ChildProcess
  public readonly completion: Promise<ShellProcessCompletion>
  public result: Nullable<ShellProcessCompletion> = null
  public exited = false
  private complete!: (result: ShellProcessCompletion) => void
  private timedOut = false
  private aborted = false
  private stopping = false
  private finished = false
  private exitCode: Nullable<number> = null
  private signal: Nullable<string> = null
  private readonly timers = new TimerScope({ name: 'ManagedShellProcess' })
  private readonly platform: NodeJS.Platform
  private readonly options: ShellManagedProcessLifecycleOptions
  private readonly hooks: ShellManagedProcessHooks
  private readonly onAbort = (): void => {
    this.aborted = true
    this.requestStop()
  }

  constructor(
    child: ChildProcess,
    options: ShellManagedProcessLifecycleOptions,
    hooks: ShellManagedProcessHooks
  ) {
    this.child = child
    this.options = options
    this.hooks = hooks
    this.platform = options.platform ?? process.platform
    this.completion = new Promise<ShellProcessCompletion>((resolve) => {
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
        void terminateProcessTree(child.pid, 'SIGKILL', { platform: this.platform })
      // 后代进程可能在直接子进程退出后继续持有继承的管道句柄。
      this.later(() => this.finish(null, true), options.drainTimeoutMs ?? ShellTuning.process.drainTimeoutMs)
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
      const retryTimers = new TimerScope({ name: 'ShellProcessStopRetry' })
      try {
        await retryTimers.withTimeout(this.options.terminationDeadlineMs ?? ShellTuning.process.terminationDeadlineMs, () => this.terminate(requestedSignal))
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
    const result: ShellProcessCompletion = {
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
    this.later(() => this.finish(null, true), this.options.terminationDeadlineMs ?? ShellTuning.process.terminationDeadlineMs)
    void this.kill(requestedSignal)
    if (requestedSignal !== 'SIGKILL')
      this.later(() => {
        void this.kill('SIGKILL')
      }, this.options.terminateGraceMs ?? ShellTuning.process.terminateGraceMs)
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
      ?? terminateProcessTree(this.child.pid ?? 0, requestedSignal, { platform: this.platform })
  }

  /** 还没收尾时才排定一个延时动作。 */
  private later(callback: () => void, delay: number): void {
    if (!this.finished) this.timers.after(delay, callback)
  }
}
