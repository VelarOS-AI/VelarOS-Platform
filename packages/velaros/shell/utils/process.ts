/**
 * 进程：有界执行短命令与平台命令、终止进程树、等待启动确认、信号编号换名字、定位 Windows 原生进程宿主。
 */

import type { ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { isPlainObject, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { CommandSpec } from '@velaros-ai/core/platform/contracts'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ShellProcessHostOptions } from '../types/local.js'
import type { ShellProcessOwnership } from '../types/shell-command.js'

import { ShellTuning } from './tuning.js'

/** 找到 Windows 原生进程宿主的可执行文件：先看显式配置，再看应用资源目录，最后看包里的 native 目录；非 Windows 或找不到返回 null。 */
export function getProcessHostPath(options: ShellProcessHostOptions = {}): Nullable<string> {
  if ((options.platform ?? process.platform) !== 'win32') return null
  const configured =
    options.hostPath ?? options.env?.VELAROS_PROCESS_HOST ?? process.env.VELAROS_PROCESS_HOST
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    configured,
    resources ? join(resources, 'windows-execution', 'velaros-process-host.exe') : undefined,
    bundledProcessHostPath(),
  ]
  const probe = options.isFile ?? existsSync
  return toNullable(
    candidates.find(
      (candidate): candidate is string => !!candidate && isAbsolute(candidate) && probe(candidate)
    )
  )
}

/**
 * 随包发布的原生宿主：从本文件往上找到包根（第一个有 package.json 的目录——源码在 shell/utils/、编译后在 dist/shell/utils/，
 * 层级不同，所以不写死往上几级），宿主在包根的 shell/native/win32-<架构>/ 下；找不到包根返回 undefined。process-host 测试会核对。
 */
function bundledProcessHostPath(): Optional<string> {
  if (!import.meta.url) return undefined
  let directory = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return join(directory, 'shell', 'native', `win32-${process.arch}`, 'velaros-process-host.exe')
}

/** 有原生宿主时把命令包进宿主启动，让子进程随父进程一起退出；没有时原样返回，并说明只能按进程树清理。 */
export function buildOwnedProcessSpec(
  spec: CommandSpec & { windowsVerbatimArguments?: boolean },
  options: ShellProcessHostOptions = {}
): { spec: CommandSpec; ownership: ShellProcessOwnership } {
  const host = getProcessHostPath(options)
  if (!host)
    return {
      spec,
      ownership: {
        backend: 'process-tree',
        parentDeathCleanup: false,
        reason: 'native-host-unavailable',
      },
    }
  return {
    spec: {
      file: host,
      args: [
        '--parent-pid',
        String(options.parentPid ?? process.pid),
        ...(spec.windowsVerbatimArguments ? ['--verbatim-arguments'] : []),
        '--',
        spec.file,
        ...spec.args,
      ],
    },
    ownership: { backend: 'windows-job', parentDeathCleanup: true, reason: 'native-job-host' },
  }
}

/** 在期限内执行一条短命令并返回 stdout，超时强制结束。 */
export function execBounded(
  file: string,
  args: string[],
  timeoutMs: number = ShellTuning.process.controlTimeoutMs
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timers = new TimerScope({ name: 'ShellProcessControl' })
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
        maxBuffer: ShellTuning.process.controlOutputBytes,
      },
      (error, stdout) => finish(error, stdout)
    )
    // execFile 自己的超时先到；看门狗晚 100 毫秒兜底，防它没收住子进程。
    timers.after(timeoutMs + 100, () => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish(new AppError('TIMEOUT', '进程控制命令超过期限'))
    })
  })
}

/** 终止一个进程及其子进程：Windows 用 taskkill，其他平台向进程组发信号；返回 true 只表示信号已发出。 */
export async function terminateProcessTree(
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

/**
 * 往子进程的 stdin 写一段文本，最多等 timeoutMs：写完返回 'written'，写失败返回那个错误，
 * 到期还没写完（进程没在读输入）返回 'pending'，数据留在管道缓冲里等进程来读。
 */
export function writeToChildInput(
  stdin: Writable,
  payload: string,
  timeoutMs: number
): Promise<'written' | 'pending' | Error> {
  return new Promise((resolve) => {
    let settled = false
    const timers = new TimerScope({ name: 'ShellConsoleInput' })
    const finish = (outcome: 'written' | 'pending' | Error): void => {
      if (settled) return
      settled = true
      timers.dispose()
      resolve(outcome)
    }
    timers.after(timeoutMs, () => finish('pending'))
    stdin.write(payload, (error) => finish(error ?? 'written'))
  })
}

/** 等待子进程确认启动成功；超时或启动失败时报错。 */
export function waitForProcessSpawn(
  child: ChildProcess,
  timeoutMs: number = ShellTuning.process.spawnTimeoutMs
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timers = new TimerScope({ name: 'ShellProcessSpawn' })
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
      reject(new AppError('TIMEOUT', '等子进程启动的确认超时'))
    })
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

/**
 * 跑一条读系统信息的平台命令（ps、lsof、netstat 等），超时与输出上限见 ShellTuning.systemInfo，返回 stdout；失败时抛 PLATFORM 错误。
 * tolerateLsofEmptyResult 为真时，lsof 以退出码 1、stderr 为空结束算作「没有匹配」，返回空结果而不是报错。
 */
export async function runPlatformCommand(
  commandSpec: CommandSpec,
  options: { tolerateLsofEmptyResult?: boolean } = {}
): Promise<{ stdout: string }> {
  try {
    return await promisify(execFile)(commandSpec.file, commandSpec.args, {
      env: process.env,
      maxBuffer: ShellTuning.systemInfo.commandOutputBytes,
      timeout: ShellTuning.systemInfo.commandTimeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
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
    )
      return { stdout: isString(failure?.stdout) ? failure.stdout : '' }

    throw new AppError('PLATFORM', `平台命令执行失败：${commandSpec.file}`, error)
  }
}

/** 信号编号换成名字（伪终端只报编号）；没有信号（0 或不给）时是 null，认不出的编号写成 SIG 加编号。 */
export function signalNameOf(signal: LooseOptional<number>): Nullable<string> {
  if (!signal) return null
  const name = Object.entries(constants.signals).find(([, number]) => number === signal)?.[0]
  return name ?? `SIG${signal}`
}
