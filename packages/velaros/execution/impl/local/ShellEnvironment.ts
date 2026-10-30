import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { isUndefined, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { createPlatform } from '@velaros-ai/core/platform'

import type { ShellEnvironmentOptions } from '../../contract/requires.js'
import type { ResolvedShell, ShellEnvironmentSnapshot } from '../../types/local.js'
import { parseLoginEnvironment } from '../../utils/environment.js'
import { replaceEnvironment } from '../../utils/shells.js'
import { ShellTuning } from '../../utils/tuning.js'

import { shellProcessManager } from './ShellProcessManager.js'
import type { ShellResolverApi } from './ShellResolver.js'
import { shellResolver } from './ShellResolver.js'

/** 登录环境的缓存、刷新和读取进程由创建者持有；返回的环境均为独立副本。 */
export interface ShellEnvironmentApi {
  /** 并发读取共用本代次加载；调用者取消只结束自己的等待，不中止其他读取。 */
  getEnvironment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv>
  /** 同步查询 shell 路径，供已有环境的原生命令适配器选参数。 */
  getShellPath(env?: NodeJS.ProcessEnv): string
  /** 返回在本代次环境上通过自检的 shell，并发自检合并。 */
  resolveShell(): Promise<ResolvedShell>
  /** 环境代次；旧刷新完成不能覆盖新代次或发出通知。 */
  getRevision(): number
  /** 重读宿主环境；只在最新刷新完成时通知订阅者。 */
  refresh(): Promise<NodeJS.ProcessEnv>
  /** 订阅最新环境刷新，返回解除订阅函数。 */
  subscribe(listener: () => void): () => void
  /** 停止准入、中止读取进程并等待所有加载与自检收尾。 */
  dispose(): Promise<void>
}

export class ShellEnvironment implements ShellEnvironmentApi {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly listeners = new Set<() => void>()
  private readonly platform: NodeJS.Platform
  private cached?: ShellEnvironmentSnapshot
  private inflight?: Promise<NodeJS.ProcessEnv>
  private resolved?: Promise<ResolvedShell>
  private revision = 0
  private closing?: Promise<void>
  private cleanupError?: AppError

  public constructor(
    private readonly options: ShellEnvironmentOptions = {},
    private readonly shells: ShellResolverApi = shellResolver
  ) {
    if (
      !isUndefined(options.captureTimeoutMs) &&
      (!Number.isFinite(options.captureTimeoutMs) || options.captureTimeoutMs <= 0)
    )
      throw new AppError('VALIDATION', '登录环境读取超时必须是有限的正数。')
    this.platform = options.platform ?? process.platform
  }

  public async getEnvironment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
    this.controller.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (this.cleanupError) throw this.cleanupError
    if (this.cached) return { ...this.cached.env }
    if (!this.inflight) {
      const revision = this.revision
      const loading = this.load()
        .then((snapshot) => {
          this.controller.signal.throwIfAborted()
          if (revision === this.revision) this.cached = snapshot
          return snapshot.env
        })
        .finally(() => {
          if (revision === this.revision) this.inflight = undefined
        })
      this.inflight = this.track(loading)
    }
    return { ...(await this.waitForEnvironment(this.inflight, signal)) }
  }

  public getShellPath(env?: NodeJS.ProcessEnv): string {
    this.controller.signal.throwIfAborted()
    // 默认环境沿用本代次已自检的 Shell；显式环境仍独立解析，刷新会清空缓存。
    if (isUndefined(env) && this.cached?.shell) return this.cached.shell.shellPath
    return this.shells.resolve({
      platform: this.platform,
      env: env ?? this.cached?.env ?? this.baseEnvironment(),
    }).shellPath
  }

  public async resolveShell(): Promise<ResolvedShell> {
    this.controller.signal.throwIfAborted()
    if (!this.resolved) {
      const revision = this.revision
      const resolving = this.getEnvironment()
        .then(
          (env) =>
            (revision === this.revision ? this.cached?.shell : undefined) ??
            this.shells.resolveReady({
              platform: this.platform,
              env,
              signal: this.controller.signal,
            })
        )
        .catch((error) => {
          if (revision === this.revision) this.resolved = undefined
          throw error
        })
      this.resolved = this.track(resolving)
    }
    const shell = await this.resolved
    this.controller.signal.throwIfAborted()
    return {
      ...shell,
      env: { ...shell.env },
      recommendation: shell.recommendation ? { ...shell.recommendation } : null,
    }
  }

  public getRevision(): number {
    return this.revision
  }

  public subscribe(listener: () => void): () => void {
    this.controller.signal.throwIfAborted()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async refresh(): Promise<NodeJS.ProcessEnv> {
    this.controller.signal.throwIfAborted()
    const revision = ++this.revision
    this.cached = undefined
    this.inflight = undefined
    this.resolved = undefined
    const env = await this.getEnvironment()
    if (revision === this.revision && !this.controller.signal.aborted) {
      for (const listener of [...this.listeners]) {
        if (revision !== this.revision || this.controller.signal.aborted) break
        try {
          listener()
        } catch (error) {
          Log.tag('ShellEnvironment').warn('environment listener failed', { error })
        }
      }
    }
    return env
  }

  public dispose(): Promise<void> {
    if (!this.closing) {
      this.controller.abort()
      this.listeners.clear()
      this.cached = undefined
      this.closing = Promise.allSettled([...this.pending]).then(() => {
        if (this.cleanupError) throw this.cleanupError
      })
    }
    return this.closing
  }

  /** 把并发代次的任务都纳入关闭回执，旧代次也要收尾。 */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    return operation.finally(() => {
      this.pending.delete(operation)
    })
  }

  /** 单次命令可以及时停止等待，应用持有的共享加载仍供其他调用者使用。 */
  private waitForEnvironment(
    operation: Promise<NodeJS.ProcessEnv>,
    signal?: AbortSignal
  ): Promise<NodeJS.ProcessEnv> {
    this.controller.signal.throwIfAborted()
    if (!signal) return operation
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      operation.then(
        (env) => {
          signal.removeEventListener('abort', abort)
          resolve(env)
        },
        (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        }
      )
    })
  }

  /** 读取宿主原始环境时就复制，刷新过程不修改宿主全局环境。 */
  private baseEnvironment(): NodeJS.ProcessEnv {
    return { ...(this.options.env?.() ?? process.env) }
  }

  private async load(): Promise<ShellEnvironmentSnapshot> {
    const env = this.baseEnvironment()
    if (this.platform === 'win32') {
      const refreshed = await this.shells.refreshWindowsEnvironment(
        env,
        this.platform,
        this.controller.signal
      )
      this.controller.signal.throwIfAborted()
      replaceEnvironment(env, refreshed.env)
      const shell = await this.shells.resolveReady({
        platform: this.platform,
        env,
        signal: this.controller.signal,
      })
      // 自检标记只属于选中的 shell，不能把共享宿主环境钉到这个候选上。
      return { env, shell }
    }
    const platform = createPlatform({ platform: this.platform, env })
    for (const shell of platform.getLoginShellCandidates(env)) {
      try {
        return { env: await this.capture(shell, env) }
      } catch (error) {
        this.controller.signal.throwIfAborted()
        if (this.cleanupError) throw this.cleanupError
        Log.tag('ShellEnvironment').warn('login environment capture failed', { shell, error })
      }
    }
    return { env }
  }

  /** 读取过程由共享进程管理器收束；失败后才尝试下一个登录 shell。 */
  private async capture(shell: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    this.controller.signal.throwIfAborted()
    const marker = `environment-${randomUUID()}`
    const child = spawn(shell, ['-lic', `printf '\\0${marker}\\0'; env -0`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const managed = shellProcessManager.manage(child, {
      abortSignal: this.controller.signal,
      timeoutMs: this.options.captureTimeoutMs ?? ShellTuning.shell.environmentCaptureTimeoutMs,
      drainTimeoutMs: ShellTuning.shell.captureDrainTimeoutMs,
      terminateGraceMs: ShellTuning.shell.captureTerminateGraceMs,
      terminationDeadlineMs: ShellTuning.shell.captureTerminationDeadlineMs,
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let exceeded = false
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (exceeded) return
      bytes += chunk.length
      if (bytes > ShellTuning.shell.environmentOutputBytes) {
        exceeded = true
        void managed.stop('SIGKILL')
      } else chunks.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-ShellTuning.shell.captureStderrChars)
    })
    const result = await managed.completion
    if (result.cleanupIncomplete)
      this.cleanupError = new AppError('PLATFORM', '登录环境读取进程未能完整清理。', undefined, {
        shell,
        ...result,
      })
    this.controller.signal.throwIfAborted()
    if (result.spawnError) throw result.spawnError
    if (result.timedOut || result.cleanupIncomplete || exceeded || result.exitCode !== 0)
      throw (
        this.cleanupError ??
        new AppError('PLATFORM', '登录 shell 环境读取失败。', undefined, {
          shell,
          ...result,
          exceeded,
          stderr,
        })
      )
    return { ...env, ...parseLoginEnvironment(Buffer.concat(chunks).toString('utf8'), marker) }
  }
}

/** 创建由宿主持有的登录环境；应用退出时 dispose，工作区只借用它。 */
export function createShellEnvironment(options: ShellEnvironmentOptions = {}): ShellEnvironmentApi {
  return new ShellEnvironment(options)
}
