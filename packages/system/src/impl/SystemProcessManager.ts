/**
 * 受管子进程登记表：`SystemProcessManager` 与整个进程唯一的 `systemProcessManager`。接口见 `contract/commands.ts` 的 `SystemProcessManagerApi`。
 * 不出包；单个受管进程的收尾逻辑在 `SystemManagedProcess.ts`。
 */

import type { ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

import type { ManagedSystemProcess, SystemProcessLifecycleOptions, SystemProcessManagerApi } from '../interface/internal.js'
import { execBounded } from '../utils/process.js'

import { SystemManagedProcess } from './SystemManagedProcess.js'

/** 已结束的进程最多保留多少条回执。 */
const MaxCompletedProcesses = 512

class SystemProcessManager implements SystemProcessManagerApi {
  private readonly processes = new Map<number, ManagedSystemProcess>()

  public manage(child: ChildProcess, options: SystemProcessLifecycleOptions = {}): ManagedSystemProcess {
    return new SystemManagedProcess(child, options, {
      track: (managed) => {
        if (managed.child.pid) this.processes.set(managed.child.pid, managed)
      },
      onFinished: () => this.pruneCompleted(),
    })
  }

  public find(pid: number): Optional<ManagedSystemProcess> {
    return this.processes.get(pid)
  }

  public async captureIdentity(pid: number, platform: NodeJS.Platform = process.platform): Promise<Nullable<string>> {
    const owned = this.processes.get(pid)
    if (owned) return owned.identity
    if (!Number.isInteger(pid) || pid <= 0) return null
    try {
      const output =
        platform === 'win32'
          ? await execBounded(
              win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
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

  public async resolveStatus(
    pid: number,
    expectedIdentity: Nullable<string>,
    platform: NodeJS.Platform = process.platform
  ): Promise<'running' | 'exited' | 'unknown'> {
    if (!expectedIdentity) return 'unknown'
    const owned = this.processes.get(pid)
    if (expectedIdentity.startsWith('managed:')) {
      if (!owned) return 'unknown'
      if (owned.identity !== expectedIdentity) return 'exited'
      if (owned.result?.cleanupIncomplete || (owned.exited && !owned.result)) return 'unknown'
      return owned.exited ? 'exited' : 'running'
    }
    const current = await this.captureIdentity(pid, platform)
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

  public async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.processes.values()]
        .filter((entry) => !entry.result || !entry.exited)
        .map((entry) => entry.stop('SIGKILL'))
    )
  }

  /** 已结束的回执超过上限时，从最早登记的开始删，直到回到上限。 */
  private pruneCompleted(): void {
    let completed = 0
    for (const entry of this.processes.values()) if (entry.result && entry.exited) completed++
    if (completed <= MaxCompletedProcesses) return
    for (const [pid, entry] of this.processes) {
      if (entry.result && entry.exited) {
        this.processes.delete(pid)
        if (--completed <= MaxCompletedProcesses) break
      }
    }
  }
}

/** 整个进程只有一份的受管子进程登记表。 */
export const systemProcessManager: SystemProcessManagerApi = new SystemProcessManager()
