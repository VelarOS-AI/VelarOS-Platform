import { type ChildProcess, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'

import { isNumber } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

export interface SystemProcessCompletion {
  exitCode: Nullable<number>
  signal: Nullable<string>
  timedOut: boolean
  aborted: boolean
  spawnError: Nullable<Error>
  cleanupIncomplete: boolean
}

export interface SystemProcessLifecycleOptions {
  platform?: NodeJS.Platform
  timeoutMs?: number
  abortSignal?: AbortSignal
  drainTimeoutMs?: number
  terminateGraceMs?: number
  terminationDeadlineMs?: number
  terminate?: (signal: NodeJS.Signals) => Promise<boolean>
}

export interface ManagedSystemProcess {
  identity: string
  child: ChildProcess
  completion: Promise<SystemProcessCompletion>
  result: Nullable<SystemProcessCompletion>
  exited: boolean
  stop: (signal?: NodeJS.Signals) => Promise<boolean>
}

const ownedProcesses = new Map<number, ManagedSystemProcess>()
const MAX_COMPLETED_PROCESSES = 512

function execBounded(file: string, args: string[], timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timers = new TimerScope({ name: 'SystemProcessControl' })
    const finish = (error: Nullable<Error>, stdout = ''): void => {
      if (settled) return
      settled = true
      timers.dispose()
      if (error) reject(error)
      else resolve(stdout)
    }
    const child = execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 32 * 1024,
      },
      (error, stdout) => finish(error, stdout)
    )
    timers.after(timeoutMs + 100, () => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish(new Error('Process control operation exceeded its deadline'))
    })
  })
}

/** Asynchronous and bounded; callers must still observe exit/close before claiming cleanup. */
export async function terminateSystemProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const platform = options.platform ?? process.platform
  try {
    if (platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      await execBounded(
        win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
        options.timeoutMs
      )
    } else {
      // 受管 POSIX 子进程都在各自独立的进程组中启动。
      process.kill(-pid, signal)
    }
    return true
  } catch {
    // arch-guard:silent-catch-ok 返回 false 明确表示未确认终止，调用方等待实际清理回执。
    return false
  }
}

/** A missing identity is unknown, never permission to signal the current occupant of a PID. */
export async function captureSystemProcessIdentity(
  pid: number,
  platform = process.platform
): Promise<Nullable<string>> {
  const owned = ownedProcesses.get(pid)
  if (owned) return owned.identity
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const output =
      platform === 'win32'
        ? await execBounded(
            win32.join(
              process.env.SystemRoot || 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe'
            ),
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`,
            ]
          )
        : await execBounded('/bin/ps', ['-p', String(pid), '-o', 'lstart='])
    return output.trim() || null
  } catch {
    // arch-guard:silent-catch-ok 返回 null 表示身份未知，无法据此授予进程终止权限。
    return null
  }
}

export function getManagedSystemProcess(pid: number): ManagedSystemProcess | undefined {
  return ownedProcesses.get(pid)
}

export async function resolveSystemProcessStatus(
  pid: number,
  expectedIdentity: Nullable<string>,
  platform = process.platform
): Promise<'running' | 'exited' | 'unknown'> {
  if (!expectedIdentity) return 'unknown'
  const owned = ownedProcesses.get(pid)
  if (expectedIdentity.startsWith('managed:')) {
    if (!owned) return 'unknown'
    if (owned.identity !== expectedIdentity) return 'exited'
    if (owned.result?.cleanupIncomplete || (owned.exited && !owned.result)) return 'unknown'
    return owned.exited ? 'exited' : 'running'
  }
  const current = await captureSystemProcessIdentity(pid, platform)
  if (!current) {
    try {
      process.kill(pid, 0)
      return 'unknown'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'unknown'
    }
  }
  return current === expectedIdentity ? 'running' : 'exited'
}

/** Own one spawned child through spawn, exit, pipe drain and bounded termination. */
export function manageSystemProcess(
  child: ChildProcess,
  options: SystemProcessLifecycleOptions = {}
): ManagedSystemProcess {
  let complete!: (result: SystemProcessCompletion) => void
  const completion = new Promise<SystemProcessCompletion>((resolve) => {
    complete = resolve
  })
  let timedOut = false
  let aborted = false
  let stopping = false
  let finished = false
  let exitCode: Nullable<number> = null
  let signal: Nullable<string> = null
  const timers = new TimerScope({ name: 'ManagedSystemProcess' })
  const later = (callback: () => void, delay: number): void => {
    if (!finished) timers.after(delay, callback)
  }
  const platform = options.platform ?? process.platform
  const owned: ManagedSystemProcess = {
    identity: `managed:${randomUUID()}`,
    child,
    completion,
    result: null,
    exited: false,
    stop: async (requestedSignal = 'SIGTERM') => {
      // 根进程退出后，后代继承的管道与清理回执仍可能尚未结束。
      if (owned.exited) {
        const result = owned.result ?? (await completion)
        return !result.cleanupIncomplete
      }
      if (finished) {
        const retryTimers = new TimerScope({ name: 'SystemProcessStopRetry' })
        try {
          await retryTimers.withTimeout(
            options.terminationDeadlineMs ?? 5_000,
            () =>
              options.terminate?.(requestedSignal) ??
              terminateSystemProcessTree(child.pid ?? 0, requestedSignal, {
                platform,
              })
          )
        } catch {
          // arch-guard:silent-catch-ok 重试结果只由已观察到的进程退出事实决定。
        } finally {
          retryTimers.dispose()
        }
        return owned.exited
      }
      requestStop(requestedSignal)
      const result = await completion
      return !result.cleanupIncomplete && owned.exited
    },
  }
  const finish = (spawnError: Nullable<Error> = null, cleanupIncomplete = false): void => {
    if (finished) return
    finished = true
    timers.dispose()
    options.abortSignal?.removeEventListener('abort', onAbort)
    child.stdin?.destroy()
    if (cleanupIncomplete) {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }
    const result = {
      exitCode,
      signal,
      timedOut,
      aborted,
      spawnError,
      cleanupIncomplete,
    }
    owned.result = result
    complete(result)
    // Retain bounded completion receipts for background status and PID identity checks.
    let completed = 0
    for (const entry of ownedProcesses.values()) if (entry.result && entry.exited) completed++
    if (completed > MAX_COMPLETED_PROCESSES) {
      for (const [pid, entry] of ownedProcesses) {
        if (entry.result && entry.exited) {
          ownedProcesses.delete(pid)
          if (--completed <= MAX_COMPLETED_PROCESSES) break
        }
      }
    }
  }
  const kill = async (requestedSignal: NodeJS.Signals): Promise<void> => {
    if (owned.exited || finished) return
    try {
      await (options.terminate?.(requestedSignal) ??
        terminateSystemProcessTree(child.pid ?? 0, requestedSignal, {
          platform,
        }))
    } catch {
      // arch-guard:silent-catch-ok 有界清理无法确认时，由 completion 返回 cleanupIncomplete。
    }
  }
  const requestStop = (requestedSignal: NodeJS.Signals = 'SIGTERM'): void => {
    if (stopping || finished) return
    stopping = true
    later(() => finish(null, true), options.terminationDeadlineMs ?? 5_000)
    void kill(requestedSignal)
    if (requestedSignal !== 'SIGKILL')
      later(() => {
        void kill('SIGKILL')
      }, options.terminateGraceMs ?? 500)
  }
  const onAbort = (): void => {
    aborted = true
    requestStop()
  }
  if (child.pid) ownedProcesses.set(child.pid, owned)
  child.once('spawn', () => {
    if (child.pid) ownedProcesses.set(child.pid, owned)
  })
  child.once('exit', (code, exitSignal) => {
    owned.exited = true
    exitCode = code
    signal = exitSignal
    // 根进程可能先于后代退出；只要后代仍存活，该进程组就仍由这里负责。
    if (platform !== 'win32' && child.pid)
      void terminateSystemProcessTree(child.pid, 'SIGKILL', { platform })
    // 后代进程可能在直接子进程退出后继续持有继承的管道句柄。
    later(() => finish(null, true), options.drainTimeoutMs ?? 1_000)
  })
  child.once('close', (code, exitSignal) => {
    owned.exited = true
    exitCode = code
    signal = exitSignal
    finish()
  })
  child.on('error', (error) => {
    owned.exited = true
    finish(error)
  })
  if (isNumber(options.timeoutMs))
    later(() => {
      timedOut = true
      requestStop()
    }, options.timeoutMs)
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener('abort', onAbort, { once: true })
  return owned
}

export function waitForSystemProcessSpawn(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timers = new TimerScope({ name: 'SystemProcessSpawn' })
    const cleanup = (): void => {
      timers.dispose()
      child.removeListener('spawn', onSpawn)
      child.removeListener('error', onError)
    }
    const onSpawn = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    timers.after(timeoutMs, () => {
      cleanup()
      reject(new Error('Process spawn acknowledgement timed out'))
    })
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

/** Explicit graceful shutdown; native host capabilities provide parent-crash containment separately. */
export async function stopOwnedSystemProcesses(): Promise<void> {
  await Promise.allSettled(
    [...ownedProcesses.values()]
      .filter((entry) => !entry.result || !entry.exited)
      .map((entry) => entry.stop('SIGKILL'))
  )
}
