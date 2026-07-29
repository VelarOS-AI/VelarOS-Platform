import { type ChildProcess, spawn } from 'node:child_process'

import {
  createDefaultKernelDaemonPaths,
  type KernelDaemonEndpointDescriptor,
  type KernelDaemonPaths,
} from './contracts'
import { type ConnectedKernelDaemon,connectToKernelDaemon, discoverKernelDaemon } from './discovery'
import { KernelClientError } from './errors'

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

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
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
  private readonly spawnProcess: typeof spawn
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private child?: ChildProcess
  private disposed = false

  public constructor(private readonly options: KernelLauncherOptions) {
    this.paths = options.paths ?? createDefaultKernelDaemonPaths()
    this.startTimeoutMs = options.startTimeoutMs ?? defaultStartTimeoutMs
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs
    this.spawnProcess = options.spawnProcess ?? spawn
    this.now = options.now ?? Date.now
    this.sleep = options.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** True when a daemon has already published a readable descriptor. */
  public async isRunning(): Promise<boolean> {
    try {
      await discoverKernelDaemon(this.paths)
      return true
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
    if (existing !== undefined) return { ...existing, started: false }

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
      // The child can die before the listener attaches, so poll its exit state too.
      if (exitFailure === undefined && hasExited(child)) {
        exitFailure = new KernelLauncherError(
          'KERNEL_START_FAILED',
          `Kernel process exited during startup (${
            child.signalCode ?? `code ${child.exitCode}`
          })`,
        )
      }
      if (exitFailure !== undefined) throw exitFailure
      const connected = await this.tryConnect()
      if (connected !== undefined) return { ...connected, process: child, started: true }
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

  /** Stops the owned Kernel process and waits for it to exit. */
  public async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    })
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
      if (
        error instanceof KernelClientError
        && (error.code === 'DAEMON_NOT_RUNNING'
          || error.code === 'DAEMON_DESCRIPTOR_INVALID')
      ) return undefined
      throw error
    }
  }

  private spawnKernel(target: KernelVersionTarget): ChildProcess {
    try {
      return this.spawnProcess(
        target.execPath ?? process.execPath,
        [target.entryPoint, ...(target.args ?? [])],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...target.env },
        },
      )
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
