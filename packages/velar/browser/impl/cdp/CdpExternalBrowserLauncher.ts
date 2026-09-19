import { execFileSync as defaultExecFileSync, spawn as defaultSpawn } from 'node:child_process'
import { existsSync as defaultExistsSync } from 'node:fs'
import {
  mkdtemp as defaultMkdtemp,
  readFile as defaultReadFile,
  rm as defaultRm,
  unlink as defaultUnlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isArray, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPageDriver } from '../../contract/requires.js'
import type { CdpChromeStderrDiagnostics, CdpDevToolsActivePort, CdpExternalBrowserChildProcess, CdpExternalBrowserLaunchOptions, CdpExternalBrowserSession, CdpExternalBrowserSpawn, CdpTargetDescription } from '../../types/cdp.js'
import { resolveCdpTargetId, resolveCdpTargetListUrl } from '../../utils/cdp/driver.js'
import { getExecutablePathCandidates, parseTargetEntry, shouldRetryLaunchAttempt } from '../../utils/cdp/launcher'
import { buildLaunchArgs, formatChromeEarlyExitMessage } from '../../utils/cdp/launcher'
import { captureChromeStderr } from '../../utils/cdp/launcher'
import { openCdpWebSocket } from '../../utils/cdp/transport.js'
import { BrowserTuning } from '../../utils/tuning'

import { BrowserPlatformCompatibility } from './BrowserPlatformCompatibility'
import {
  CdpBrowserPageDriver,
  type CdpBrowserPageDriverConnectOptions,
} from './CdpBrowserPageDriver'
import { CdpWebSocketTransport } from './CdpWebSocketTransport'

export interface CdpExternalBrowserLauncherDependencies {
  spawn?: LooseOptional<CdpExternalBrowserSpawn>
  existsSync?: LooseOptional<(path: string) => boolean>
  mkdtemp?: LooseOptional<(prefix: string) => Promise<string>>
  readFile?: LooseOptional<(path: string, encoding: 'utf8') => Promise<string>>
  rm?: LooseOptional<(path: string, options: { recursive: true; force: true }) => Promise<void>>
  unlink?: LooseOptional<(path: string) => Promise<void>>
  fetch?: LooseOptional<typeof fetch>
  processKill?: LooseOptional<(pid: number, signal?: NodeJS.Signals | number) => boolean>
  execFileSync?: LooseOptional<typeof defaultExecFileSync>
  connectPageDriver?: LooseOptional<
    (
      webSocketDebuggerUrl: string,
      options: CdpBrowserPageDriverConnectOptions
    ) => Promise<BrowserPageDriver>
  >
  sleep?: LooseOptional<(ms: number) => Promise<void>>
}

/**
 * 外部浏览器启动器：找到本机的 Chrome / Chromium，用独立的用户数据目录把它拉起来，读出调试端口，
 * 连上之后交回一个 page 级的 CDP 会话。
 *
 * 实例归运行时：一个运行时一份，它记着自己拉起来的进程与临时目录，收尾时负责杀进程、删目录。
 */
export interface CdpExternalBrowserLauncherApi {
  /** 拉起（或接上）一个外部浏览器，回一个可用的 page 级 CDP 会话。 */
  launch(options?: CdpExternalBrowserLaunchOptions): Promise<CdpExternalBrowserSession>
}

class CdpExternalBrowserLauncher implements CdpExternalBrowserLauncherApi {
  private readonly log = Log.tag('CdpExternalBrowserLauncher')
  private readonly spawn: CdpExternalBrowserSpawn
  private readonly existsSync: (path: string) => boolean
  private readonly mkdtemp: (prefix: string) => Promise<string>
  private readonly readFile: (path: string, encoding: 'utf8') => Promise<string>
  private readonly rm: (path: string, options: { recursive: true; force: true }) => Promise<void>
  private readonly unlink: (path: string) => Promise<void>
  private readonly fetch: typeof fetch
  private readonly processKill: (pid: number, signal?: NodeJS.Signals | number) => boolean
  private readonly execFileSync: typeof defaultExecFileSync
  private readonly connectPageDriver: (
    webSocketDebuggerUrl: string,
    options: CdpBrowserPageDriverConnectOptions
  ) => Promise<BrowserPageDriver>
  private readonly sleep: (ms: number) => Promise<void>

  constructor(dependencies: CdpExternalBrowserLauncherDependencies = {}) {
    this.spawn = dependencies.spawn ?? defaultSpawn
    this.existsSync = dependencies.existsSync ?? defaultExistsSync
    this.mkdtemp = dependencies.mkdtemp ?? defaultMkdtemp
    this.readFile = dependencies.readFile ?? defaultReadFile
    this.rm = dependencies.rm ?? defaultRm
    this.unlink = dependencies.unlink ?? defaultUnlink
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.processKill = dependencies.processKill ?? process.kill
    this.execFileSync = dependencies.execFileSync ?? defaultExecFileSync
    this.connectPageDriver =
      dependencies.connectPageDriver ??
      ((webSocketDebuggerUrl, options) => this.connectDefaultPageDriver(webSocketDebuggerUrl, options))
    this.sleep =
      dependencies.sleep ?? ((ms) => TimerScope.sleep(ms, { label: 'cdpExternalBrowser.poll' }))
  }

  /** 没注入连接器时的缺省连法：现连一条 CDP WebSocket，包成页面驱动。 */
  private async connectDefaultPageDriver(
    webSocketDebuggerUrl: string,
    options: CdpBrowserPageDriverConnectOptions = {}
  ): Promise<BrowserPageDriver> {
    const socket = await openCdpWebSocket(webSocketDebuggerUrl, options)
    return new CdpBrowserPageDriver({
      transport: new CdpWebSocketTransport({ socket, timeoutMs: options.timeoutMs }),
      initialUrl: options.initialUrl,
      initialTitle: options.initialTitle,
      downloadPath: options.downloadPath,
      targetListUrl: resolveCdpTargetListUrl(webSocketDebuggerUrl),
      activeTargetId: resolveCdpTargetId(webSocketDebuggerUrl),
      fetch: options.fetch ?? this.fetch,
      onDispose: options.onDispose,
    })
  }

  public async launch(
    options: CdpExternalBrowserLaunchOptions = {}
  ): Promise<CdpExternalBrowserSession> {
    const platform = options.platform ?? process.platform
    const executablePath = this.resolveExecutablePath(options.executablePath, platform)
    const ownsUserDataDir = !options.userDataDir?.trim()
    const configuredUserDataDir = options.userDataDir?.trim()
    const timeoutMs = options.timeoutMs ?? BrowserTuning.externalBrowser.launchTimeoutMs
    let lastError: unknown = null

    for (let attempt = 1; attempt <= BrowserTuning.externalBrowser.launchMaxAttempts; attempt += 1) {
      const userDataDir = ownsUserDataDir
        ? await this.mkdtemp(join(tmpdir(), 'velaros-cdp-browser-'))
        : configuredUserDataDir!
      try {
        return await this.launchAttempt({
          executablePath,
          userDataDir,
          ownsUserDataDir,
          options,
          platform,
          timeoutMs,
        })
      } catch (error) {
        lastError = error
        if (!shouldRetryLaunchAttempt(error, attempt)) throw error

        const appError = AppError.from(error)
        this.log.debug('外部浏览器启动早退，准备重试', {
          attempt,
          maxAttempts: BrowserTuning.externalBrowser.launchMaxAttempts,
          error: appError.message,
        })
        await this.sleep(BrowserTuning.externalBrowser.launchRetryDelayMs)
      }
    }

    throw AppError.from(lastError)
  }

  private async launchAttempt(input: {
    executablePath: string
    userDataDir: string
    ownsUserDataDir: boolean
    options: CdpExternalBrowserLaunchOptions
    platform: NodeJS.Platform
    timeoutMs: number
  }): Promise<CdpExternalBrowserSession> {
    const {
      executablePath,
      userDataDir,
      ownsUserDataDir,
      options,
      platform,
      timeoutMs,
    } = input
    const downloadPath = options.downloadPath?.trim() || join(userDataDir, 'Downloads')
    const launchEnv = {
      ...process.env,
      ...(options.env ?? {}),
    }

    await this.unlink(join(userDataDir, 'DevToolsActivePort')).catch(() => {
      // arch-guard:silent-catch-ok 启动前清理允许文件不存在；新浏览器会写入自己的端口文件。
    })
    const child = this.spawn(executablePath, buildLaunchArgs(userDataDir, options, {
      env: launchEnv,
      platform,
    }), {
      detached: platform !== 'win32',
      env: launchEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr = captureChromeStderr(child)

    try {
      const activePort = await this.waitForDevToolsActivePort(child, userDataDir, timeoutMs, stderr)
      const pageTarget = await this.waitForPageTarget(activePort.port, options.url, timeoutMs)
      let disposed = false
      const disposeBrowser = (): void => {
        if (disposed) return
        disposed = true
        this.disposeLaunchedBrowser(child, ownsUserDataDir ? userDataDir : null, platform)
      }
      const driver = await this.connectPageDriver(pageTarget.webSocketDebuggerUrl, {
        initialUrl: pageTarget.url,
        initialTitle: pageTarget.title,
        downloadPath,
      })

      return {
        driver,
        port: activePort.port,
        userDataDir,
        webSocketDebuggerUrl: pageTarget.webSocketDebuggerUrl,
        dispose: disposeBrowser,
      }
    } catch (error) {
      this.disposeLaunchedBrowser(child, ownsUserDataDir ? userDataDir : null, platform)
      throw error
    }
  }

  private resolveExecutablePath(
    configuredPath: LooseOptional<string>,
    platform: NodeJS.Platform
  ): string {
    const executablePath = configuredPath?.trim()
    if (executablePath) return executablePath

    const candidates = getExecutablePathCandidates(platform)
    const match = candidates.find((candidate) => this.existsSync(candidate))
    if (match) return match
    if (platform === 'linux') return 'google-chrome'

    throw new AppError(
      'VALIDATION',
      '找不到可用的 Chrome/Chromium，可在外部浏览器配置中提供 executablePath。'
    )
  }

  private async waitForDevToolsActivePort(
    child: CdpExternalBrowserChildProcess,
    userDataDir: string,
    timeoutMs: number,
    stderr: CdpChromeStderrDiagnostics
  ): Promise<CdpDevToolsActivePort> {
    const deadline = Date.now() + timeoutMs
    const path = join(userDataDir, 'DevToolsActivePort')

    while (Date.now() <= deadline) {
      if (isPresent(child.exitCode)) {
        await this.sleep(0)
        throw new AppError(
          'EXECUTION_FAILED',
          formatChromeEarlyExitMessage(child, stderr)
        )
      }

      const activePort = await this.readDevToolsActivePort(path)
      if (activePort) return activePort

      await this.sleep(BrowserTuning.externalBrowser.pollIntervalMs)
    }

    throw new AppError('TIMEOUT', '等待外部浏览器 DevToolsActivePort 超时。')
  }

  private async readDevToolsActivePort(path: string): Promise<Nullable<CdpDevToolsActivePort>> {
    try {
      const content = await this.readFile(path, 'utf8')
      const lines = content.split(/\r?\n/u)
      const port = Number.parseInt(lines[0]?.trim() || '', 10)
      if (!Number.isInteger(port) || port <= 0) return null
      return {
        port,
        browserWebSocketPath: lines[1]?.trim() || '/devtools/browser',
      }
    }
    // arch-guard:silent-catch-ok DevToolsActivePort 在 Chrome 写入前会反复缺席，轮询路径不刷日志。
    catch {
      return null
    }
  }

  private async waitForPageTarget(
    port: number,
    targetUrl: LooseOptional<string>,
    timeoutMs: number
  ): Promise<CdpTargetDescription> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() <= deadline) {
      const target = await this.fetchPageTarget(port, targetUrl)
      if (target) return target

      await this.sleep(BrowserTuning.externalBrowser.pollIntervalMs)
    }

    throw new AppError('TIMEOUT', '等待外部浏览器 page target 超时。')
  }

  private async fetchPageTarget(
    port: number,
    targetUrl: LooseOptional<string>
  ): Promise<Nullable<CdpTargetDescription>> {
    const listTarget = await this.fetchTargetList(port)
    const pageTarget = listTarget.find((target) => target.type === 'page')
    if (pageTarget) return pageTarget

    return this.createPageTarget(port, targetUrl)
  }

  private async fetchTargetList(port: number): Promise<CdpTargetDescription[]> {
    try {
      const response = await this.fetch(`http://127.0.0.1:${port}/json/list`)
      if (!response.ok) return []

      return this.parseTargets(await response.text())
    } catch (error) {
      this.log.debug('获取外部浏览器 CDP target list 失败', {
        port,
        error: AppError.from(error).message,
      })
      return []
    }
  }

  private async createPageTarget(
    port: number,
    targetUrl: LooseOptional<string>
  ): Promise<Nullable<CdpTargetDescription>> {
    try {
      const url = encodeURIComponent(targetUrl?.trim() || 'about:blank')
      const response = await this.fetch(`http://127.0.0.1:${port}/json/new?${url}`, {
        method: 'PUT',
      })
      if (!response.ok) return null

      return this.parseTarget(await response.text())
    } catch (error) {
      this.log.debug('创建外部浏览器 CDP page target 失败', {
        port,
        error: AppError.from(error).message,
      })
      return null
    }
  }

  private parseTargets(rawJson: string): CdpTargetDescription[] {
    try {
      const parsed = JSON.parse(rawJson)
      if (!isArray(parsed)) return []

      return parsed
        .map((entry) => parseTargetEntry(entry))
        .filter((target): target is CdpTargetDescription => !!target)
    } catch (error) {
      this.log.debug('解析外部浏览器 CDP target list 失败', {
        error: AppError.from(error).message,
      })
      return []
    }
  }

  private parseTarget(rawJson: string): Nullable<CdpTargetDescription> {
    try {
      return parseTargetEntry(JSON.parse(rawJson))
    } catch (error) {
      this.log.debug('解析外部浏览器 CDP target 失败', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  private disposeLaunchedBrowser(
    child: CdpExternalBrowserChildProcess,
    tempUserDataDir: Nullable<string>,
    platform: NodeJS.Platform
  ): void {
    if (!child.killed) {
      const killedProcessGroup = this.killLaunchedBrowserProcessGroup(child, platform)
      if (!killedProcessGroup) {
        child.kill('SIGTERM')
      }
    }
    if (tempUserDataDir) {
      void this.rm(tempUserDataDir, { recursive: true, force: true })
    }
  }

  private killLaunchedBrowserProcessGroup(
    child: CdpExternalBrowserChildProcess,
    platform: NodeJS.Platform
  ): boolean {
    const pid = child.pid
    if (!isPresent(pid) || !Number.isInteger(pid) || pid <= 0) return false

    if (platform === 'win32') {
      const commandSpec = new BrowserPlatformCompatibility(platform).getProcessTreeKillCommandSpec(
        pid,
        'SIGTERM'
      )
      if (!commandSpec) return false

      try {
        this.execFileSync(commandSpec.file, commandSpec.args, { stdio: 'ignore' })
        return true
      } catch (error) {
        this.log.debug('清理 Windows 外部浏览器进程树失败，回退到主进程 kill', {
          pid,
          error: AppError.from(error).message,
        })
        return false
      }
    }

    try {
      return this.processKill(-pid, 'SIGTERM')
    } catch (error) {
      this.log.debug('清理外部浏览器进程组失败，回退到主进程 kill', {
        pid,
        error: AppError.from(error).message,
      })
      return false
    }
  }
}

export { CdpExternalBrowserLauncher }
export type { CdpBrowserPageDriverConnectOptions }
