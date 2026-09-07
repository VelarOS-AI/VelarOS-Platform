import { type ChildProcess,execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'

export interface SystemProcessCompletion {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  spawnError: Error | null
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
  result: SystemProcessCompletion | null
  exited: boolean
  stop: (signal?: NodeJS.Signals) => Promise<boolean>
}

const ownedProcesses = new Map<number, ManagedSystemProcess>()
const MAX_COMPLETED_PROCESSES = 512

function execBounded(file: string, args: string[], timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, stdout = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(stdout)
    }
    const child = execFile(file, args, {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
      maxBuffer: 32 * 1024,
    }, (error, stdout) => finish(error, stdout))
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish(new Error('Process control operation exceeded its deadline'))
    }, timeoutMs + 100)
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
      await execBounded(win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], options.timeoutMs)
    } else {
      // Managed POSIX children are launched in their own process group.
      process.kill(-pid, signal)
    }
    return true
  } catch {
    return false
  }
}

/** A missing identity is unknown, never permission to signal the current occupant of a PID. */
export async function captureSystemProcessIdentity(pid: number, platform = process.platform): Promise<string | null> {
  const owned = ownedProcesses.get(pid)
  if (owned) return owned.identity
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const output = platform === 'win32'
      ? await execBounded(win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command',
          `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`])
      : await execBounded('/bin/ps', ['-p', String(pid), '-o', 'lstart='])
    return output.trim() || null
  } catch {
    return null
  }
}

export function getManagedSystemProcess(pid: number): ManagedSystemProcess | undefined {
  return ownedProcesses.get(pid)
}

export async function resolveSystemProcessStatus(
  pid: number, expectedIdentity: string | null, platform = process.platform
): Promise<'running' | 'exited' | 'unknown'> {
  if (!expectedIdentity) return 'unknown'
  const owned = ownedProcesses.get(pid)
  if (expectedIdentity.startsWith('managed:')) {
    if (!owned) return 'unknown'
    if (owned.identity !== expectedIdentity) return 'exited'
    if (owned.result?.cleanupIncomplete) return 'unknown'
    return owned.exited ? 'exited' : 'running'
  }
  const current = await captureSystemProcessIdentity(pid, platform)
  if (!current) {
    try { process.kill(pid, 0); return 'unknown' } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'unknown'
    }
  }
  return current === expectedIdentity ? 'running' : 'exited'
}

/** Own one spawned child through spawn, exit, pipe drain and bounded termination. */
export function manageSystemProcess(child: ChildProcess, options: SystemProcessLifecycleOptions = {}): ManagedSystemProcess {
  let complete!: (result: SystemProcessCompletion) => void
  const completion = new Promise<SystemProcessCompletion>((resolve) => { complete = resolve })
  let timedOut = false
  let aborted = false
  let stopping = false
  let finished = false
  let exitCode: number | null = null
  let signal: string | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (callback: () => void, delay: number): void => {
    const timer = setTimeout(() => { timers.delete(timer); callback() }, delay)
    timers.add(timer)
  }
  const platform = options.platform ?? process.platform
  const owned: ManagedSystemProcess = {
    identity: `managed:${randomUUID()}`, child, completion, result: null, exited: false,
    stop: async (requestedSignal = 'SIGTERM') => {
      if (owned.exited) return !owned.result?.cleanupIncomplete
      if (finished) {
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(resolve, options.terminationDeadlineMs ?? 5_000)
          Promise.resolve().then(() => options.terminate?.(requestedSignal)
            ?? terminateSystemProcessTree(child.pid ?? 0, requestedSignal, { platform }))
            .catch(() => false).finally(() => { clearTimeout(deadline); resolve() })
        })
        return owned.exited
      }
      requestStop(requestedSignal)
      const result = await completion
      return !result.cleanupIncomplete && owned.exited
    },
  }
  const finish = (spawnError: Error | null = null, cleanupIncomplete = false): void => {
    if (finished) return
    finished = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    options.abortSignal?.removeEventListener('abort', onAbort)
    child.stdin?.destroy()
    if (cleanupIncomplete) {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }
    const result = { exitCode, signal, timedOut, aborted, spawnError, cleanupIncomplete }
    owned.result = result
    complete(result)
    // Retain bounded completion receipts for background status and PID identity checks.
    let completed = 0
    for (const entry of ownedProcesses.values()) if (entry.result && entry.exited) completed++
    if (completed > MAX_COMPLETED_PROCESSES) {
      for (const [pid, entry] of ownedProcesses) {
        if (entry.result && entry.exited) { ownedProcesses.delete(pid); if (--completed <= MAX_COMPLETED_PROCESSES) break }
      }
    }
  }
  const kill = async (requestedSignal: NodeJS.Signals): Promise<void> => {
    if (owned.exited || finished) return
    try {
      await (options.terminate?.(requestedSignal) ?? terminateSystemProcessTree(child.pid ?? 0, requestedSignal, { platform }))
    } catch {
      // Completion reports cleanupIncomplete when the bounded cleanup cannot be confirmed.
    }
  }
  const requestStop = (requestedSignal: NodeJS.Signals = 'SIGTERM'): void => {
    if (stopping || finished) return
    stopping = true
    later(() => finish(null, true), options.terminationDeadlineMs ?? 5_000)
    void kill(requestedSignal)
    if (requestedSignal !== 'SIGKILL') later(() => { void kill('SIGKILL') }, options.terminateGraceMs ?? 500)
  }
  const onAbort = (): void => { aborted = true; requestStop() }
  if (child.pid) ownedProcesses.set(child.pid, owned)
  child.once('spawn', () => { if (child.pid) ownedProcesses.set(child.pid, owned) })
  child.once('exit', (code, exitSignal) => {
    owned.exited = true
    exitCode = code
    signal = exitSignal
    // The root may exit before its descendants; the process group remains ours while they live.
    if (platform !== 'win32' && child.pid) void terminateSystemProcessTree(child.pid, 'SIGKILL', { platform })
    // A descendant can keep inherited pipe handles open after the direct child exits.
    later(() => finish(null, true), options.drainTimeoutMs ?? 1_000)
  })
  child.once('close', (code, exitSignal) => {
    owned.exited = true
    exitCode = code
    signal = exitSignal
    finish()
  })
  child.on('error', (error) => { owned.exited = true; finish(error) })
  if (options.timeoutMs !== undefined) later(() => { timedOut = true; requestStop() }, options.timeoutMs)
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener('abort', onAbort, { once: true })
  return owned
}

export function waitForSystemProcessSpawn(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); child.removeListener('spawn', onSpawn); child.removeListener('error', onError) }
    const onSpawn = (): void => { cleanup(); resolve() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Process spawn acknowledgement timed out')) }, timeoutMs)
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

/** Explicit graceful shutdown; native host capabilities provide parent-crash containment separately. */
export async function stopOwnedSystemProcesses(): Promise<void> {
  await Promise.allSettled([...ownedProcesses.values()].filter((entry) => !entry.exited).map((entry) => entry.stop('SIGKILL')))
}
