/**
 * 受管子进程登记表：`SystemProcessManager` 与整个进程唯一的 `systemProcessManager`。接口 `SystemProcessManagerApi` 在本文件的类上方。
 * 不出包；单个受管进程的收尾逻辑在 `SystemManagedProcess.ts`。
 */

import type { ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

import { execBounded } from '../utils/process.js'

import type { ManagedSystemProcess, SystemManagedProcessLifecycleOptions } from './SystemManagedProcess.js'
import { SystemManagedProcess } from './SystemManagedProcess.js'

/** 已结束的进程最多保留多少条回执。 */
const MaxCompletedProcesses = 512

/**
 * 受管子进程登记表：本包启动的每个子进程都在这里登记，从启动、退出、管道排空到有界终止都有人收尾。
 *
 * 实现是 `SystemProcessManager`，整个进程只有一份（`systemProcessManager`），不出包。
 * 已结束的进程保留最多 512 条回执，供后台任务查状态和核对 pid 身份。
 */
export interface SystemProcessManagerApi {
  /**
   * 接管一个刚 spawn 出来的子进程并登记。
   *
   * 之后的超时、取消、退出后的管道排空都有期限：超时或取消先发 SIGTERM，宽限期后补 SIGKILL，终止期限到了还没收尾就标 cleanupIncomplete。
   * POSIX 上直接子进程退出后，会顺手杀掉仍然存活的整个进程组。
   */
  manage(child: ChildProcess, options?: SystemManagedProcessLifecycleOptions): ManagedSystemProcess
  /** 按 pid 找本包登记过的受管进程；没登记过返回 undefined。 */
  find(pid: number): Optional<ManagedSystemProcess>
  /**
   * 取一个 pid 的身份标记，防止 pid 被系统复用后误杀别的进程。
   *
   * 本包登记过的进程返回它的受管身份；其他进程读系统记录的启动时间（Windows 用 PowerShell，其他平台用 ps）。
   * 读不到返回 null，表示身份未知；未知不等于可以动它。
   */
  captureIdentity(pid: number, platform?: NodeJS.Platform): Promise<Nullable<string>>
  /**
   * 判断一个 pid 此刻是不是当初那个进程在跑。
   *
   * 身份对得上且没退出为 running；身份变了或已退出为 exited；没有身份、或根进程已退出而收尾回执还没到，一律 unknown，不猜。
   */
  resolveStatus(pid: number, expectedIdentity: Nullable<string>, platform?: NodeJS.Platform): Promise<'running' | 'exited' | 'unknown'>
  /** 应用退出前调用：给所有还没结束的受管进程发 SIGKILL 并等它们收尾。父进程崩溃时的兜底由 Windows 原生宿主另外保证。 */
  stopAll(): Promise<void>
}

class SystemProcessManager implements SystemProcessManagerApi {
  private readonly processes = new Map<number, ManagedSystemProcess>()

  public manage(child: ChildProcess, options: SystemManagedProcessLifecycleOptions = {}): ManagedSystemProcess {
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
