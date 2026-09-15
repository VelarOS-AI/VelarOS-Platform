/**
 * 进程：有界执行短命令与平台命令、终止进程树、等待启动确认、定位 Windows 原生进程宿主。
 */

import type { ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { isPlainObject, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import type { CommandSpec } from '@velaros-ai/platform/contracts'

import type { SystemProcessHostOptions } from '../types/commands.js'
import type { SystemProcessOwnership } from '../types/system.js'

/** 找到 Windows 原生进程宿主的可执行文件：先看显式配置，再看应用资源目录，最后看包里的 native 目录；非 Windows 或找不到返回 null。 */
export function getSystemProcessHostPath(options: SystemProcessHostOptions = {}): Nullable<string> {
  if ((options.platform ?? process.platform) !== 'win32') return null
  const configured = options.hostPath ?? options.env?.VELAROS_PROCESS_HOST ?? process.env.VELAROS_PROCESS_HOST
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    configured,
    resources ? join(resources, 'windows-execution', 'velaros-process-host.exe') : undefined,
    // 本文件在 src/utils/（编译后 dist/utils/），往上两级是包根目录，
    // 随包发布的原生宿主在包根的 native/ 下。挪动本文件时要同步改这里，process-host 测试会核对。
    import.meta.url ? fileURLToPath(new URL(`../../native/win32-${process.arch}/velaros-process-host.exe`, import.meta.url)) : undefined,
  ]
  const probe = options.isFile ?? existsSync
  return toNullable(candidates.find((candidate): candidate is string => !!candidate && isAbsolute(candidate) && probe(candidate)))
}

/** 有原生宿主时把命令包进宿主启动，让子进程随父进程一起退出；没有时原样返回，并说明只能按进程树清理。 */
export function buildSystemOwnedProcessSpec(
  spec: CommandSpec & { windowsVerbatimArguments?: boolean },
  options: SystemProcessHostOptions = {}
): { spec: CommandSpec; ownership: SystemProcessOwnership } {
  const host = getSystemProcessHostPath(options)
  if (!host) return {
    spec,
    ownership: { backend: 'process-tree', parentDeathCleanup: false, reason: 'native-host-unavailable' },
  }
  return {
    spec: { file: host, args: [
      '--parent-pid', String(options.parentPid ?? process.pid),
      ...(spec.windowsVerbatimArguments ? ['--verbatim-arguments'] : []),
      '--', spec.file, ...spec.args,
    ] },
    ownership: { backend: 'windows-job', parentDeathCleanup: true, reason: 'native-job-host' },
  }
}

/** 在期限内执行一条短命令并返回 stdout，超时强制结束。 */
export function execBounded(file: string, args: string[], timeoutMs = 2_000): Promise<string> {
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

/** 终止一个进程及其子进程：Windows 用 taskkill，其他平台向进程组发信号；返回 true 只表示信号已发出。 */
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

/** 等待子进程确认启动成功；超时或启动失败时报错。 */
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

/** 平台命令（ps、lsof、netstat 等）的输出上限。 */
const MaxPlatformCommandBuffer = 8 * 1024 * 1024

/**
 * 跑一条读系统信息的平台命令（ps、lsof、netstat 等），2 秒超时，返回 stdout；失败时抛 PLATFORM 错误。
 * tolerateLsofEmptyResult 为真时，lsof 以退出码 1、stderr 为空结束算作「没有匹配」，返回空结果而不是报错。
 */
export async function runPlatformCommand(
  commandSpec: CommandSpec,
  options: { tolerateLsofEmptyResult?: boolean } = {}
): Promise<{ stdout: string }> {
  try {
    return await promisify(execFile)(commandSpec.file, commandSpec.args, {
      env: process.env,
      maxBuffer: MaxPlatformCommandBuffer,
      timeout: 2_000, killSignal: 'SIGKILL', windowsHide: true,
    })
  } catch (error) {
    // lsof 在"没有任何匹配"时以 exit 1 且空 stderr 结束——这不是失败，是空结果集。
    // 判据必须三条齐（调用方要求容忍 + 确实是 lsof + stderr 为空），否则真的执行失败会被吞掉。
    const failure = isPlainObject(error) ? error : null
    if (
      options.tolerateLsofEmptyResult &&
      commandSpec.file === 'lsof' &&
      String(failure?.code) === '1' &&
      !(isString(failure?.stderr) ? failure.stderr.trim() : '')
    ) return { stdout: isString(failure?.stdout) ? failure.stdout : '' }

    throw new AppError('PLATFORM', `平台命令执行失败：${commandSpec.file}`, error)
  }
}
