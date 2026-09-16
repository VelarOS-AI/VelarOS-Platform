import { type ChildProcess, spawn } from 'node:child_process'

import { isNotUndefined, isUndefined, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { KernelClientErrorCodes } from '../../contract/constants'
import type { KernelDaemonEndpointDescriptor, KernelDaemonPaths } from '../../types/kernel'
import type { KernelVersionResolver, KernelVersionTarget } from '../../types/serve'
import { KernelClientError } from '../../utils/errors'
import { createDefaultKernelDaemonPaths } from '../../utils/rpc/descriptor'
import {
  hasChildProcessExited,
  isKernelDaemonProcessAlive,
  meansKernelDaemonIsNotRunning,
} from '../../utils/serve/daemon-process'
import { KernelTuning } from '../../utils/tuning'
import { type KernelDaemonDirectoryConnection,kernelDaemons } from '../client/KernelDaemonDirectory'

const log = Log.tag('KernelLauncher')

/** 起一个 Kernel 启动器要交进来的东西：版本解析器，外加一组可替换的超时与进程原语。 */
export interface KernelLauncherOptions {
  /** descriptor、锁与 socket 的落点；不给就用缺省的运行目录。 */
  readonly paths?: KernelDaemonPaths
  /** 由谁回答「这次该跑哪个版本」。 */
  readonly resolver: KernelVersionResolver
  /** spawn 之后等 descriptor 出现多久，毫秒；不给取可调参数表里的值。 */
  readonly startTimeoutMs?: number
  /** 轮询 descriptor 的间隔，毫秒；不给取可调参数表里的值。 */
  readonly pollIntervalMs?: number
  /** SIGTERM 之后等它自己退的宽限期，过期改发 SIGKILL。 */
  readonly stopGraceMs?: number
  /** SIGKILL 之后还等多久；再不退就不等了。 */
  readonly stopKillGraceMs?: number
  /** 起子进程用哪个实现；测试替换它，不然就是 `node:child_process` 的 `spawn`。 */
  readonly spawnProcess?: typeof spawn
  /** 现在几点；测试替换它来控制超时。 */
  readonly now?: () => number
  /** 等一会儿；测试替换它来跳过真实等待。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/** 一次启动的结果：连上的客户端，加上这次是不是由本启动器起的那个进程。 */
export interface KernelLauncherResult extends KernelDaemonDirectoryConnection {
  /** 复用了已经在跑的守护进程时没有这个字段。 */
  readonly process?: ChildProcess
  /** true = 这次是本启动器起的，false = 附着到已有的守护进程。 */
  readonly started: boolean
}

/**
 * 起（或附着到）共享的 Kernel 进程，并交回一个验过健康的客户端；实例归要用 Kernel 的产品。
 *
 * 安装、切版本与回滚归 `kernel-updater`；这个类只负责选中已激活的版本、持有子进程，并在任何
 * 产品流量进去之前证明那个端点答得出一次健康的握手。
 */
export interface KernelLauncherApi {
  /** 真的有守护进程在跑吗：既要 descriptor 读得出来，也要它记的 pid 还活着。 */
  isRunning(): Promise<boolean>
  /** 连上共享 Kernel，没在跑就先起一个；起不来或超时抛带码的错误。 */
  ensureRunning(): Promise<KernelLauncherResult>
  /** 核一次连上的 Kernel 自报的健康；自报已停止时抛 `KERNEL_UNHEALTHY`。 */
  verifyHealthy(connection: KernelDaemonDirectoryConnection): Promise<void>
  /** 停掉本启动器起的那个进程：SIGTERM → 宽限 → SIGKILL → 再等一小段就不等了。 */
  stop(): Promise<void>
  /** 停掉当前进程，再按重新解析出来的版本起一个。 */
  restart(): Promise<KernelLauncherResult>
  /** 回收启动器：停掉进程，之后再调 `ensureRunning` 一律抛 `LAUNCHER_DISPOSED`。 */
  dispose(): Promise<void>
  /** 回当前发布着的端点 descriptor；没有守护进程在跑时抛带码的错误。 */
  getDescriptor(): Promise<KernelDaemonEndpointDescriptor>
}

/** 共享 Kernel 进程的启动器。 */
export class KernelLauncher implements KernelLauncherApi {
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
    this.startTimeoutMs = options.startTimeoutMs ?? KernelTuning.launcherStartTimeoutMs
    this.pollIntervalMs = options.pollIntervalMs ?? KernelTuning.launcherPollIntervalMs
    this.stopGraceMs = options.stopGraceMs ?? KernelTuning.launcherStopGraceMs
    this.stopKillGraceMs = options.stopKillGraceMs ?? KernelTuning.launcherStopKillGraceMs
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
      const descriptor = await kernelDaemons.discover(this.paths)
      return isKernelDaemonProcessAlive(descriptor.pid)
    } catch (error) {
      if (error instanceof KernelClientError) return false
      throw error
    }
  }

  /**
   * 连上共享 Kernel，没在跑就先起一个。
   *
   * 复用活着的守护进程是常态：几个产品共用一个 Kernel，第一个进来的把它起起来，其余的附着上去。
   */
  public async ensureRunning(): Promise<KernelLauncherResult> {
    this.assertUsable()
    const existing = await this.tryConnect()
    if (isNotUndefined(existing)) return { ...existing, started: false }

    const target = await this.options.resolver.resolveActiveVersion()
    const child = this.spawnKernel(target)
    this.child = child

    let exitFailure: KernelClientError | undefined
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      exitFailure = new KernelClientError({
        code: KernelClientErrorCodes.kernelStartFailed,
        message: `Kernel 进程在启动过程中退出（${signal ?? `退出码 ${code}`}）`,
      })
    })

    const deadline = this.now() + this.startTimeoutMs
    while (this.now() < deadline) {
      // 子进程可能在监听器挂载前退出，因此循环内也要检查退出状态。
      if (isUndefined(exitFailure) && hasChildProcessExited(child)) {
        exitFailure = new KernelClientError({
          code: KernelClientErrorCodes.kernelStartFailed,
          message: `Kernel 进程在启动过程中退出（${
            child.signalCode ?? `退出码 ${child.exitCode}`
          }）`,
        })
      }
      if (isNotUndefined(exitFailure)) throw exitFailure
      const connected = await this.tryConnect()
      if (isNotUndefined(connected)) return { ...connected, process: child, started: true }
      await this.sleep(this.pollIntervalMs)
    }

    await this.stop()
    throw new KernelClientError({
      code: KernelClientErrorCodes.kernelStartTimeout,
      message: `Kernel 在 ${this.startTimeoutMs}ms 内没有发布端点`,
    })
  }

  public async verifyHealthy(
    connection: KernelDaemonDirectoryConnection,
  ): Promise<void> {
    const health = await connection.client.health()
    if (health.status === 'stopped') {
      throw new KernelClientError({
        code: KernelClientErrorCodes.kernelUnhealthy,
        message: 'Kernel 自报运行时已停止',
      })
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
    if (hasChildProcessExited(child)) return

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

  /** 按轮询间隔等一个子进程退出，超过给定期限就回 false。 */
  private async waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (hasChildProcessExited(child)) return true
      await this.sleep(this.pollIntervalMs)
    }
    return hasChildProcessExited(child)
  }

  public async restart(): Promise<KernelLauncherResult> {
    await this.stop()
    return this.ensureRunning()
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.stop()
  }

  public getDescriptor(): Promise<KernelDaemonEndpointDescriptor> {
    return kernelDaemons.discover(this.paths)
  }

  /** 试着连已有的守护进程；「没在跑」一类的失败当作没连上，别的照抛。 */
  private async tryConnect(): Promise<KernelDaemonDirectoryConnection | undefined> {
    try {
      return await kernelDaemons.connect(this.paths)
    } catch (error) {
      if (meansKernelDaemonIsNotRunning(error)) {
        log.debug('未能连上已有的 Kernel 守护进程，按「没在跑」处理', { error })
        return undefined
      }
      throw error
    }
  }

  /** 起一个脱离父进程的守护进程；起不来时折成 `KERNEL_START_FAILED`。 */
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
      throw new KernelClientError({
        code: KernelClientErrorCodes.kernelStartFailed,
        message: `Kernel ${target.version} 起不来`,
        cause: error,
      })
    }
  }

  /** 回收之后不许再起 Kernel。 */
  private assertUsable(): void {
    if (!this.disposed) return
    throw new KernelClientError({
      code: KernelClientErrorCodes.launcherDisposed,
      message: '已回收的 Kernel 启动器不能再启动 Kernel',
    })
  }
}

/** 建一个共享 Kernel 进程的启动器;实例归要用 Kernel 的产品,起停都由它负责。 */
export function createKernelLauncher(
  options: KernelLauncherOptions,
): KernelLauncherApi {
  return new KernelLauncher(options)
}
