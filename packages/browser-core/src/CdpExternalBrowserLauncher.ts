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

import { isArray, isEmpty,isNonBlankString, isObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPageDriver } from './BrowserPageDriver'
import { BrowserPlatformCompatibility } from './BrowserPlatformCompatibility'
import {
  CdpBrowserPageDriver,
  type CdpBrowserPageDriverConnectOptions,
} from './CdpBrowserPageDriver'

export interface CdpExternalBrowserLaunchOptions {
  executablePath?: LooseOptional<string>
  userDataDir?: LooseOptional<string>
  profileDirectory?: LooseOptional<string>
  useRealKeychain?: LooseOptional<boolean>
  downloadPath?: LooseOptional<string>
  url?: LooseOptional<string>
  args?: LooseOptional<string[]>
  env?: LooseOptional<Record<string, string | undefined>>
  platform?: LooseOptional<NodeJS.Platform>
  timeoutMs?: LooseOptional<number>
}

export interface CdpExternalBrowserSession {
  driver: BrowserPageDriver
  port: number
  userDataDir: string
  webSocketDebuggerUrl: string
  dispose(): void
}

/** 启动/接入外部浏览器并返回 page-level CDP driver 的 host 无关 launcher 面。 */
export interface BrowserExternalPageLauncher {
  launch(options?: CdpExternalBrowserLaunchOptions): Promise<CdpExternalBrowserSession>
}

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

interface CdpExternalBrowserSpawnOptions {
  detached: boolean
  env: Record<string, string | undefined>
  stdio: ['ignore', 'ignore', 'pipe']
}

interface CdpExternalBrowserChildProcess {
  pid?: LooseOptional<number>
  exitCode?: LooseOptional<number>
  signalCode?: LooseOptional<string>
  killed?: boolean
  stderr?: LooseOptional<NodeJS.ReadableStream>
  kill(signal?: NodeJS.Signals | number): boolean
}

type CdpExternalBrowserSpawn = (
  command: string,
  args: string[],
  options: CdpExternalBrowserSpawnOptions
) => CdpExternalBrowserChildProcess

interface CdpDevToolsActivePort {
  port: number
  browserWebSocketPath: string
}

interface CdpTargetDescription {
  type: string
  url: string
  title: string
  webSocketDebuggerUrl: string
}

interface CdpChromeStderrDiagnostics {
  lines: string[]
  pending: string
}

type CdpExternalBrowserLaunchEnv = Record<string, string | undefined>

const DefaultCdpExternalBrowserLaunchTimeoutMs = 30_000
const CdpExternalBrowserPollIntervalMs = 50
const CdpExternalBrowserLaunchMaxAttempts = 3
const CdpExternalBrowserLaunchRetryDelayMs = 500
const CdpChromeStderrMaxLines = 20

class CdpExternalBrowserLauncher {
  private readonly log = logRuntime.tag('CdpExternalBrowserLauncher')
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
      ((webSocketDebuggerUrl, options) =>
        CdpBrowserPageDriver.connect(webSocketDebuggerUrl, options))
    this.sleep =
      dependencies.sleep ?? ((ms) => TimerScope.sleep(ms, { label: 'cdpExternalBrowser.poll' }))
  }

  public async launch(
    options: CdpExternalBrowserLaunchOptions = {}
  ): Promise<CdpExternalBrowserSession> {
    const platform = options.platform ?? process.platform
    const executablePath = this.resolveExecutablePath(options.executablePath, platform)
    const ownsUserDataDir = !options.userDataDir?.trim()
    const configuredUserDataDir = options.userDataDir?.trim()
    const timeoutMs = options.timeoutMs ?? DefaultCdpExternalBrowserLaunchTimeoutMs
    let lastError: unknown = null

    for (let attempt = 1; attempt <= CdpExternalBrowserLaunchMaxAttempts; attempt += 1) {
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
        if (!this.shouldRetryLaunchAttempt(error, attempt)) throw error

        const appError = AppError.from(error)
        this.log.debug('外部浏览器启动早退，准备重试', {
          attempt,
          maxAttempts: CdpExternalBrowserLaunchMaxAttempts,
          error: appError.message,
        })
        await this.sleep(CdpExternalBrowserLaunchRetryDelayMs)
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

    await this.unlink(join(userDataDir, 'DevToolsActivePort')).catch(() => undefined)
    const child = this.spawn(executablePath, this.buildLaunchArgs(userDataDir, options, {
      env: launchEnv,
      platform,
    }), {
      detached: platform !== 'win32',
      env: launchEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr = this.captureChromeStderr(child)

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

  private shouldRetryLaunchAttempt(error: unknown, attempt: number): boolean {
    if (attempt >= CdpExternalBrowserLaunchMaxAttempts) return false

    const appError = AppError.from(error)
    return appError.code === 'EXECUTION_FAILED'
  }

  private buildLaunchArgs(
    userDataDir: string,
    options: CdpExternalBrowserLaunchOptions,
    runtime: {
      env: CdpExternalBrowserLaunchEnv
      platform: NodeJS.Platform
    }
  ): string[] {
    const profileDirectory = options.profileDirectory?.trim()
    const useRealKeychain = options.useRealKeychain || isNonBlankString(profileDirectory)
    const args = [
      '--remote-debugging-port=0',
      // 让 Chrome 明示此独立窗口正受自动化控制。带产品名的调试横幅属于
      // chrome.debugger 扩展；这里的原始 CDP 传输使用 Chrome 原生自动化提示。
      '--enable-automation',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-backgrounding-occluded-windows',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-features=Translate',
      '--metrics-recording-only',
    ]
    if (!useRealKeychain) {
      args.push('--password-store=basic')
      args.push('--use-mock-keychain')
    }
    args.push(`--user-data-dir=${userDataDir}`)
    if (isNonBlankString(profileDirectory)) {
      args.push(`--profile-directory=${profileDirectory}`)
    }
    args.push(...(options.args ?? []))
    this.addLinuxChromeStabilityFlags(args, runtime)
    const url = options.url?.trim()
    if (url) args.push(url)

    return args
  }

  private addLinuxChromeStabilityFlags(
    args: string[],
    runtime: {
      env: CdpExternalBrowserLaunchEnv
      platform: NodeJS.Platform
    }
  ): void {
    if (runtime.platform !== 'linux') return
    if (!isString(runtime.env.CI)) return

    if (!args.includes('--no-sandbox')) {
      args.push('--no-sandbox')
    }
    if (!args.includes('--disable-dev-shm-usage')) {
      args.push('--disable-dev-shm-usage')
    }
  }

  private resolveExecutablePath(
    configuredPath: LooseOptional<string>,
    platform: NodeJS.Platform
  ): string {
    const executablePath = configuredPath?.trim()
    if (executablePath) return executablePath

    const candidates = this.getExecutablePathCandidates(platform)
    const match = candidates.find((candidate) => this.existsSync(candidate))
    if (match) return match
    if (platform === 'linux') return 'google-chrome'

    throw new AppError(
      'VALIDATION',
      '找不到可用的 Chrome/Chromium，可在外部浏览器配置中提供 executablePath。'
    )
  }

  private getExecutablePathCandidates(platform: NodeJS.Platform): string[] {
    if (platform === 'darwin')
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]

    if (platform === 'win32') {
      const roots = [
        process.env.LOCALAPPDATA,
        process.env.PROGRAMFILES,
        process.env['PROGRAMFILES(X86)'],
      ].filter((root): root is string => isNonBlankString(root))
      return roots.flatMap((root) => [
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ])
    }

    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
    ]
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
          this.formatChromeEarlyExitMessage(child, stderr)
        )
      }

      const activePort = await this.readDevToolsActivePort(path)
      if (activePort) return activePort

      await this.sleep(CdpExternalBrowserPollIntervalMs)
    }

    throw new AppError('TIMEOUT', '等待外部浏览器 DevToolsActivePort 超时。')
  }

  private captureChromeStderr(child: CdpExternalBrowserChildProcess): CdpChromeStderrDiagnostics {
    const diagnostics: CdpChromeStderrDiagnostics = { lines: [], pending: '' }
    const stderr = child.stderr
    if (!stderr) return diagnostics

    stderr.setEncoding?.('utf8')
    stderr.on('data', (chunk) => {
      this.recordChromeStderrChunk(diagnostics, chunk)
    })
    let chunk = stderr.read?.()
    while (isPresent(chunk)) {
      this.recordChromeStderrChunk(diagnostics, chunk)
      chunk = stderr.read?.()
    }

    return diagnostics
  }

  private recordChromeStderrChunk(
    diagnostics: CdpChromeStderrDiagnostics,
    chunk: unknown
  ): void {
    const text = isString(chunk) ? chunk : String(chunk)
    const parts = `${diagnostics.pending}${text}`.split(/\r?\n/u)
    diagnostics.pending = parts.pop() ?? ''
    for (const part of parts) {
      this.pushChromeStderrLine(diagnostics, part)
    }
  }

  private pushChromeStderrLine(
    diagnostics: CdpChromeStderrDiagnostics,
    line: string
  ): void {
    const trimmed = line.trim()
    if (!trimmed) return

    diagnostics.lines.push(trimmed)
    if (diagnostics.lines.length > CdpChromeStderrMaxLines) {
      diagnostics.lines.shift()
    }
  }

  private formatChromeEarlyExitMessage(
    child: CdpExternalBrowserChildProcess,
    stderr: CdpChromeStderrDiagnostics
  ): string {
    if (stderr.pending.trim()) {
      this.pushChromeStderrLine(stderr, stderr.pending)
      stderr.pending = ''
    }

    const status = isPresent(child.exitCode)
      ? `exitCode=${child.exitCode}`
      : `signal=${child.signalCode ?? 'unknown'}`
    const lines = this.selectChromeStderrDiagnostics(stderr.lines)
    if (isEmpty(lines)) return `外部浏览器启动失败，进程在写入 DevToolsActivePort 前退出：${status}`

    const hint = this.hasSandboxStderr(lines)
      ? '\nHint: Linux/CI/容器环境可尝试在外部浏览器 args 中加入 --no-sandbox。'
      : ''
    return [
      `外部浏览器启动失败，进程在写入 DevToolsActivePort 前退出：${status}`,
      'Chrome stderr:',
      ...lines.map((line) => `  ${line}`),
    ].join('\n') + hint
  }

  private selectChromeStderrDiagnostics(lines: string[]): string[] {
    const relevant = lines.filter((line) => {
      const lower = line.toLowerCase()
      return (
        lower.includes('error') ||
        lower.includes('fatal') ||
        lower.includes('sandbox') ||
        lower.includes('namespace') ||
        lower.includes('permission') ||
        lower.includes('cannot') ||
        lower.includes('failed') ||
        lower.includes('abort')
      )
    })
    if (!isEmpty(relevant)) return relevant.slice(-5)

    return lines.slice(-5)
  }

  private hasSandboxStderr(lines: string[]): boolean {
    return lines.some((line) => {
      const lower = line.toLowerCase()
      return lower.includes('sandbox') || lower.includes('namespace')
    })
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
    // @arch-guard:suspend velaros/code-style/require-error-logging 理由：DevToolsActivePort 在 Chrome 写入前会反复 ENOENT，轮询路径不应刷 debug 日志。
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

      await this.sleep(CdpExternalBrowserPollIntervalMs)
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
        .map((entry) => this.parseTargetEntry(entry))
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
      return this.parseTargetEntry(JSON.parse(rawJson))
    } catch (error) {
      this.log.debug('解析外部浏览器 CDP target 失败', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  private parseTargetEntry(entry: unknown): Nullable<CdpTargetDescription> {
    if (!isObject(entry)) return null
    const record = entry as Record<string, unknown>
    if (!isString(record.webSocketDebuggerUrl)) return null

    return {
      type: isString(record.type) ? record.type : '',
      url: isString(record.url) ? record.url : '',
      title: isString(record.title) ? record.title : '',
      webSocketDebuggerUrl: record.webSocketDebuggerUrl,
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
