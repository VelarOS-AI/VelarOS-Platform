import { type ChildProcess, spawn } from 'node:child_process'

import { isNotNull, isNotUndefined, isObject, isUndefined, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  createDefaultKernelDaemonPaths,
  type KernelDaemonEndpointDescriptor,
  type KernelDaemonPaths,
} from './contracts/descriptor'
import { type ConnectedKernelDaemon,connectToKernelDaemon, discoverKernelDaemon } from './discovery'
import { KernelClientError, KernelRpcClientError } from './errors'

const log = Log.tag('KernelLauncher')

export type KernelLauncherErrorCode =
  | 'KERNEL_BINARY_MISSING'
  | 'KERNEL_START_FAILED'
  | 'KERNEL_START_TIMEOUT'
  | 'KERNEL_UNHEALTHY'
  | 'LAUNCHER_DISPOSED'

export class KernelLauncherError extends Error {
  public constructor(
    public readonly code: KernelLauncherErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'KernelLauncherError'
  }
}

/**
 * Resolves which installed Kernel version the launcher should run.
 *
 * The launcher deliberately does not know the install layout; `kernel-updater`
 * owns that and supplies the resolved entry point. Keeping the two apart means
 * a version switch never races a process start.
 */
export interface KernelVersionResolver {
  resolveActiveVersion(): Promise<KernelVersionTarget>
}

export interface KernelVersionTarget {
  readonly version: string
  /** Absolute path to the Kernel entry script or executable. */
  readonly entryPoint: string
  readonly execPath?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export interface KernelLauncherOptions {
  readonly paths?: KernelDaemonPaths
  readonly resolver: KernelVersionResolver
  /** How long to wait for the descriptor to appear after spawning. */
  readonly startTimeoutMs?: number
  readonly pollIntervalMs?: number
  /** SIGTERM 之后等它自己退的宽限期，过期改发 SIGKILL。 */
  readonly stopGraceMs?: number
  /** SIGKILL 之后还等多久；再不退就不等了。 */
  readonly stopKillGraceMs?: number
  readonly spawnProcess?: typeof spawn
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface KernelLaunchResult extends ConnectedKernelDaemon {
  /** Undefined when an already-running daemon was reused. */
  readonly process?: ChildProcess
  readonly started: boolean
}

const defaultStartTimeoutMs = 30_000
const defaultPollIntervalMs = 100
const defaultStopGraceMs = 5_000
const defaultStopKillGraceMs = 2_000

function hasExited(child: ChildProcess): boolean {
  return isNotNull(child.exitCode) || isNotNull(child.signalCode)
}

/**
 * descriptor 里记的守护进程还活着吗。
 *
 * EPERM 表示进程存在但属于别人（共享守护进程的正常情形），照样算活着。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isObject(error) && Reflect.get(error, 'code') === 'EPERM'
  }
}

/**
 * 这个错误是不是「守护进程没在跑」。
 *
 * 崩溃后残留的 descriptor 指着一个没人听的端点：连接会以
 * `TRANSPORT_CONNECT_FAILED` 失败，而不是 `DAEMON_NOT_RUNNING`。原来只吞后者，于是
 * `ensureRunning()` 直接把连接错误抛出去，一次都不 spawn，启动器被一份陈旧文件卡死。
 */
function meansDaemonIsNotRunning(error: unknown): boolean {
  if (error instanceof KernelClientError) return error.code === 'DAEMON_NOT_RUNNING'
    || error.code === 'DAEMON_DESCRIPTOR_INVALID'
  if (error instanceof KernelRpcClientError) return error.code === 'TRANSPORT_CONNECT_FAILED'
    || error.code === 'TRANSPORT_DISCONNECTED'
  return false
}

/**
 * Starts (or attaches to) the shared Kernel process and hands back a verified client.
 *
 * Installation, version switching, and rollback belong to `kernel-updater`;
 * this class only selects the already-activated version, owns the child
 * process, and proves the endpoint answers a healthy handshake before any
 * product traffic reaches it.
 */
export class KernelLauncher {
  private readonly paths: KernelDaemonPaths
  private readonly startTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly stopGraceMs: number
  private readonly stopKillGraceMs: number
  private readonly spawnProcess: typeof spawn
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private child?: ChildProcess
  private disposed = false

  public constructor(private readonly options: KernelLauncherOptions) {
    this.paths = options.paths ?? createDefaultKernelDaemonPaths()
    this.startTimeoutMs = options.startTimeoutMs ?? defaultStartTimeoutMs
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs
    this.stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs
    this.stopKillGraceMs = options.stopKillGraceMs ?? defaultStopKillGraceMs
    this.spawnProcess = options.spawnProcess ?? spawn
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => TimerScope.sleep(ms, { label: 'KernelLauncher.poll' }))
  }

  /**
   * 真的有守护进程在跑吗。
   *
   * 只看「descriptor 读得出来」会说谎：守护进程崩溃后文件还在，`isRunning()` 照样回 true。
   * 这里再核一遍文件里记的 pid 是否还活着。
   */
  public async isRunning(): Promise<boolean> {
    try {
      const descriptor = await discoverKernelDaemon(this.paths)
      return isProcessAlive(descriptor.pid)
    } catch (error) {
      if (error instanceof KernelClientError) return false
      throw error
    }
  }

  /**
   * Connects to the shared Kernel, starting it first when nothing is running.
   *
   * Reusing a live daemon is the normal path: several products share one
   * Kernel, so the first one in starts it and the rest attach.
   */
  public async ensureRunning(): Promise<KernelLaunchResult> {
    this.assertUsable()
    const existing = await this.tryConnect()
    if (isNotUndefined(existing)) return { ...existing, started: false }

    const target = await this.options.resolver.resolveActiveVersion()
    const child = this.spawnKernel(target)
    this.child = child

    let exitFailure: KernelLauncherError | undefined
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      exitFailure = new KernelLauncherError(
        'KERNEL_START_FAILED',
        `Kernel process exited during startup (${signal ?? `code ${code}`})`,
      )
    })

    const deadline = this.now() + this.startTimeoutMs
    while (this.now() < deadline) {
      // 子进程可能在监听器挂载前退出，因此循环内也要检查退出状态。
      if (isUndefined(exitFailure) && hasExited(child)) {
        exitFailure = new KernelLauncherError(
          'KERNEL_START_FAILED',
          `Kernel process exited during startup (${
            child.signalCode ?? `code ${child.exitCode}`
          })`,
        )
      }
      if (isNotUndefined(exitFailure)) throw exitFailure
      const connected = await this.tryConnect()
      if (isNotUndefined(connected)) return { ...connected, process: child, started: true }
      await this.sleep(this.pollIntervalMs)
    }

    await this.stop()
    throw new KernelLauncherError(
      'KERNEL_START_TIMEOUT',
      `Kernel did not publish an endpoint within ${this.startTimeoutMs}ms`,
    )
  }

  /** Verifies the connected Kernel reports a usable health status. */
  public async verifyHealthy(
    connection: ConnectedKernelDaemon,
  ): Promise<void> {
    const health = await connection.client.health()
    if (health.status === 'stopped') {
      throw new KernelLauncherError(
        'KERNEL_UNHEALTHY',
        'Kernel reports a stopped runtime',
      )
    }
  }

  /**
   * 停掉本启动器起的那个 Kernel 进程。
   *
   * SIGTERM 之后有期限：宽限期内没退就 SIGKILL，再等一小段就不等了。原来是
   * `await new Promise(resolve => child.once('exit', resolve))` 无限等——一个卡住不退的
   * 守护进程能把调用方的停机流程永远挂在这里。
   */
  public async stop(): Promise<void> {
    const child = this.child
    if (isUndefined(child)) return
    this.child = undefined
    if (hasExited(child)) return

    child.kill('SIGTERM')
    if (await this.waitForExit(child, this.stopGraceMs)) return
    log.warn('Kernel 进程在 SIGTERM 宽限期内没有退出，改发 SIGKILL', {
      graceMs: this.stopGraceMs,
      pid: child.pid,
    })
    child.kill('SIGKILL')
    if (await this.waitForExit(child, this.stopKillGraceMs)) return
    log.error('Kernel 进程在 SIGKILL 之后仍未退出，不再等待', { pid: child.pid })
  }

  private async waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (hasExited(child)) return true
      await this.sleep(this.pollIntervalMs)
    }
    return hasExited(child)
  }

  /** Stops the current process and starts a freshly resolved version. */
  public async restart(): Promise<KernelLaunchResult> {
    await this.stop()
    return this.ensureRunning()
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.stop()
  }

  public getDescriptor(): Promise<KernelDaemonEndpointDescriptor> {
    return discoverKernelDaemon(this.paths)
  }

  private async tryConnect(): Promise<ConnectedKernelDaemon | undefined> {
    try {
      return await connectToKernelDaemon(this.paths)
    } catch (error) {
      if (meansDaemonIsNotRunning(error)) {
        log.debug('未能连上已有的 Kernel 守护进程，按「没在跑」处理', { error })
        return undefined
      }
      throw error
    }
  }

  private spawnKernel(target: KernelVersionTarget): ChildProcess {
    try {
      const child = this.spawnProcess(
        target.execPath ?? process.execPath,
        [target.entryPoint, ...(target.args ?? [])],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...target.env },
        },
      )
      // detached 起的是共享守护进程：不 unref 的话父进程会被它吊着退不出去。
      child.unref()
      return child
    } catch (error) {
      throw new KernelLauncherError(
        'KERNEL_START_FAILED',
        `Kernel ${target.version} could not be started`,
        error,
      )
    }
  }

  private assertUsable(): void {
    if (!this.disposed) return
    throw new KernelLauncherError(
      'LAUNCHER_DISPOSED',
      'Disposed Kernel launcher cannot start a Kernel',
    )
  }
}
