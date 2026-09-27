// 域：外部浏览器启动器——给每次 launch 在外部浏览器里开一个新标签页，交回挂在这一页上的驱动。
//
// ## 找浏览器的先后
//  1. 用户自己开着的 Chrome：默认配置目录（正式版、Beta、Dev、Canary）里有 DevToolsActivePort 的，就是用户在
//     chrome://inspect/#remote-debugging 打开了远程调试。Chrome 每来一条新连接都弹窗请用户允许，所以等得久一些；
//     `preferRunningBrowser: false` 时整步跳过，一个用户目录都不读。
//  2. `userDataDir` 上还开着的浏览器（我们早先在这个目录上拉起的）；没给 userDataDir 时是本实例早先在临时目录上拉起、还开着的那个。
//  3. 都没有才拉起一个：给了 userDataDir 就拉在它上面（目录一直留着），不给就拉在自己建的临时目录上（收尾删掉）。
// 过期的端口文件、连不上、用户拒绝、等超时，都记一条 debug 换下一个。
//
// ## 不变量（改这些会破什么）
//  - **一个浏览器一条连接**：连上的浏览器按浏览器级 WebSocket 地址记着，后来的 launch 复用，只另开标签页——
//    用户自己的 Chrome 每条新连接都要点一次「允许」。找浏览器一次只做一件：两个会话同时 launch 同一个配置目录，
//    不能拉起两个 Chrome，也不能让用户点两次「允许」。
//  - **会话只关自己的标签页**：launch 交回的 dispose 关它开的那一页，绝不关浏览器；浏览器的去留归启动器的 dispose。
//  - **只杀自己拉起的**：dispose 杀我们拉起的进程、删我们建的临时目录；只是连上的浏览器（用户自己的 Chrome、早先留下的）绝不关。
//  - **连接断了就划掉**：用户退出浏览器、socket 断开，那条记录立刻划掉（我们拉起的顺手收尸），下次 launch 重连或重新拉起。
//  - **不改用户自己 Chrome 的下载行为**：下载目录只设在我们自己配置目录上的浏览器上；设了是整个浏览器上下文的事。
import { execFileSync as defaultExecFileSync, spawn as defaultSpawn } from 'node:child_process'
import { existsSync as defaultExistsSync } from 'node:fs'
import {
  mkdtemp as defaultMkdtemp,
  readFile as defaultReadFile,
  rm as defaultRm,
  unlink as defaultUnlink,
} from 'node:fs/promises'
import { homedir as defaultHomedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  CdpChromeStderrDiagnostics,
  CdpDevToolsActivePort,
  CdpExternalBrowserChildProcess,
  CdpExternalBrowserLaunchEnv,
  CdpExternalBrowserLaunchOptions,
  CdpExternalBrowserSession,
  CdpExternalBrowserSpawn,
  CdpWebSocketLike,
} from '../../types/cdp.js'
import {
  buildBrowserWebSocketUrl,
  devToolsActivePortPath,
  getDefaultUserDataDirCandidates,
  getExecutablePathCandidates,
  parseDevToolsActivePort,
  shouldRetryLaunchAttempt,
} from '../../utils/cdp/launcher'
import { buildLaunchArgs, formatChromeEarlyExitMessage } from '../../utils/cdp/launcher'
import { captureChromeStderr } from '../../utils/cdp/launcher'
import { BrowserTuning } from '../../utils/tuning'

import { BrowserPlatformCompatibility } from './BrowserPlatformCompatibility'
import { CdpBrowserConnection, type CdpBrowserConnectionApi } from './CdpBrowserConnection'
import { CdpBrowserPageDriver } from './CdpBrowserPageDriver'

/** 外部浏览器启动器的依赖：缺省是真的进程、文件与 WebSocket；测试换成假的，不碰真的 Chrome 与用户目录。 */
export interface CdpExternalBrowserLauncherDependencies {
  /** 拉起浏览器进程。 */
  spawn?: LooseOptional<CdpExternalBrowserSpawn>
  /** 文件在不在：找可执行文件、找调试端口文件。 */
  existsSync?: LooseOptional<(path: string) => boolean>
  /** 建临时用户数据目录。 */
  mkdtemp?: LooseOptional<(prefix: string) => Promise<string>>
  /** 读调试端口文件。 */
  readFile?: LooseOptional<(path: string, encoding: 'utf8') => Promise<string>>
  /** 删临时用户数据目录。 */
  rm?: LooseOptional<(path: string, options: { recursive: true; force: true }) => Promise<void>>
  /** 拉起之前删掉上一次留下的调试端口文件。 */
  unlink?: LooseOptional<(path: string) => Promise<void>>
  /** 给进程（组）发信号。 */
  processKill?: LooseOptional<(pid: number, signal?: NodeJS.Signals | number) => boolean>
  /** Windows 上杀进程树。 */
  execFileSync?: LooseOptional<typeof defaultExecFileSync>
  /** 轮询之间等一会儿。 */
  sleep?: LooseOptional<(ms: number) => Promise<void>>
  /** 造 WebSocket；不给用运行环境的 WebSocket。 */
  createSocket?: LooseOptional<(url: string) => CdpWebSocketLike>
  /** 当前用户的主目录：拼用户自己的 Chrome 配置目录用。 */
  homedir?: LooseOptional<() => string>
  /** 拼用户自己的 Chrome 配置目录时读的环境变量（LOCALAPPDATA、XDG_CONFIG_HOME、CHROME_CONFIG_HOME）；不给用 process.env。 */
  env?: LooseOptional<CdpExternalBrowserLaunchEnv>
}

/** 启动器记着的一个浏览器：共用的那条连接，是不是我们拉起的（要杀的进程、要删的临时目录），下载先落在哪。 */
export interface CdpExternalBrowserLauncherBrowser {
  /** 浏览器级连接：这个浏览器里的标签页会话都挂在它上面。 */
  connection: CdpBrowserConnectionApi
  /** 我们拉起的进程；只是连上的浏览器是 null，收尾时绝不杀。 */
  child: Nullable<CdpExternalBrowserChildProcess>
  /** 我们建的临时用户数据目录，收尾时删；用户给的目录、用户自己的 Chrome 配置目录都是 null。 */
  temporaryUserDataDir: Nullable<string>
  /** 页面下载先落进的目录；用户自己的 Chrome 是 null（不接管它的下载）。 */
  downloadPath: Nullable<string>
  /** 拉起它时的平台：收尾杀进程按平台走。 */
  platform: NodeJS.Platform
}

/**
 * 外部浏览器启动器：先接用户开着的 Chrome，再接 userDataDir 上开着的，都没有才拉起；每个浏览器一条浏览器级连接，
 * 每次 launch 在上面开一个新标签页。实例归运行时，记着自己拉起的进程与临时目录，dispose 时收掉。
 */
export interface CdpExternalBrowserLauncherApi {
  /** 在外部浏览器里开一个新标签页，交回挂在这一页上的驱动；交回的 dispose 只关这一页，从不关浏览器。 */
  launch(options?: CdpExternalBrowserLaunchOptions): Promise<CdpExternalBrowserSession>
  /** 收尾：断开全部连接，杀掉我们拉起的浏览器、删掉我们建的临时目录；只是连上的浏览器（用户自己的 Chrome）不关。 */
  dispose(): void
}

class CdpExternalBrowserLauncher implements CdpExternalBrowserLauncherApi {
  private readonly log = Log.tag('CdpExternalBrowserLauncher')
  private readonly spawn: CdpExternalBrowserSpawn
  private readonly existsSync: (path: string) => boolean
  private readonly mkdtemp: (prefix: string) => Promise<string>
  private readonly readFile: (path: string, encoding: 'utf8') => Promise<string>
  private readonly rm: (path: string, options: { recursive: true; force: true }) => Promise<void>
  private readonly unlink: (path: string) => Promise<void>
  private readonly processKill: (pid: number, signal?: NodeJS.Signals | number) => boolean
  private readonly execFileSync: typeof defaultExecFileSync
  private readonly sleep: (ms: number) => Promise<void>
  private readonly createSocket: LooseOptional<(url: string) => CdpWebSocketLike>
  private readonly homedir: () => string
  private readonly env: CdpExternalBrowserLaunchEnv
  /** 连着的浏览器，按浏览器级 WebSocket 地址记。 */
  private readonly browsers = new Map<string, CdpExternalBrowserLauncherBrowser>()
  /** 找浏览器的排队：一次只找一个。 */
  private acquiring: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(dependencies: CdpExternalBrowserLauncherDependencies = {}) {
    this.spawn = dependencies.spawn ?? defaultSpawn
    this.existsSync = dependencies.existsSync ?? defaultExistsSync
    this.mkdtemp = dependencies.mkdtemp ?? defaultMkdtemp
    this.readFile = dependencies.readFile ?? defaultReadFile
    this.rm = dependencies.rm ?? defaultRm
    this.unlink = dependencies.unlink ?? defaultUnlink
    this.processKill = dependencies.processKill ?? process.kill
    this.execFileSync = dependencies.execFileSync ?? defaultExecFileSync
    this.sleep =
      dependencies.sleep ?? ((ms) => TimerScope.sleep(ms, { label: 'cdpExternalBrowser.poll' }))
    this.createSocket = dependencies.createSocket
    this.homedir = dependencies.homedir ?? defaultHomedir
    this.env = dependencies.env ?? process.env
  }

  public async launch(
    options: CdpExternalBrowserLaunchOptions = {}
  ): Promise<CdpExternalBrowserSession> {
    const platform = options.platform ?? process.platform
    const acquired = this.acquiring.then(() => this.acquireBrowser(options, platform))
    this.acquiring = acquired.catch(() => {
      // arch-guard:silent-catch-ok 排队只管先后：这次没找到浏览器由 launch 自己抛给调用方，不挡后面排着的。
    })
    return this.openPage(await acquired, options)
  }

  public dispose(): void {
    this.disposed = true
    for (const [url, browser] of [...this.browsers]) {
      browser.connection.dispose()
      this.forget(url, browser)
    }
  }

  private async acquireBrowser(
    options: CdpExternalBrowserLaunchOptions,
    platform: NodeJS.Platform
  ): Promise<CdpExternalBrowserLauncherBrowser> {
    if (this.disposed) throw new AppError('EXECUTION_ABORTED', '外部浏览器启动器已经释放。')

    if (options.preferRunningBrowser ?? true) {
      for (const userDataDir of this.resolveUserChromeDirs(platform)) {
        const browser = await this.connectRunningBrowser(userDataDir, platform, {
          timeoutMs: BrowserTuning.externalBrowser.userApprovalTimeoutMs,
          downloadPath: null,
        })
        if (browser) return browser
      }
    }

    const userDataDir = options.userDataDir?.trim()
    if (userDataDir) {
      const browser = await this.connectRunningBrowser(userDataDir, platform, {
        timeoutMs: BrowserTuning.externalBrowser.connectTimeoutMs,
        downloadPath: options.downloadPath?.trim() || join(userDataDir, 'Downloads'),
      })
      if (browser) return browser
    } else {
      const temporary = [...this.browsers.values()].find(
        (browser) => !!browser.temporaryUserDataDir && !browser.connection.isClosed()
      )
      if (temporary) return temporary
    }

    return this.spawnBrowser(options, platform, userDataDir)
  }

  /** 用户自己的 Chrome 的默认配置目录；拿不到主目录就只列拼得出来的。 */
  private resolveUserChromeDirs(platform: NodeJS.Platform): string[] {
    let home = ''
    try {
      home = this.homedir()
    } catch (error) {
      this.log.debug('读不到用户主目录，只按环境变量找用户自己的 Chrome', {
        error: AppError.from(error).message,
      })
    }
    return getDefaultUserDataDirCandidates(platform, { home, env: this.env })
  }

  /** 接这个配置目录上开着的浏览器：连着的直接复用，没连着的现连；没开着、连不上、被拒、超时都交回 null。 */
  private async connectRunningBrowser(
    userDataDir: string,
    platform: NodeJS.Platform,
    input: { timeoutMs: number; downloadPath: Nullable<string> }
  ): Promise<Nullable<CdpExternalBrowserLauncherBrowser>> {
    const activePort = await this.readDevToolsActivePort(userDataDir, platform)
    if (!activePort) return null

    const url = buildBrowserWebSocketUrl(activePort)
    const cached = this.browsers.get(url)
    if (cached && !cached.connection.isClosed()) return cached

    let connection: CdpBrowserConnectionApi
    try {
      connection = await new CdpBrowserConnection().connect(url, {
        createSocket: this.createSocket,
        timeoutMs: input.timeoutMs,
      })
    } catch (error) {
      this.log.debug('这个配置目录上的浏览器接不上，换下一个', {
        userDataDir,
        url,
        error: AppError.from(error).message,
      })
      return null
    }
    this.log.info('接上了开着的浏览器', { userDataDir, url })
    return this.remember(url, {
      connection,
      child: null,
      temporaryUserDataDir: null,
      downloadPath: input.downloadPath,
      platform,
    })
  }

  private async spawnBrowser(
    options: CdpExternalBrowserLaunchOptions,
    platform: NodeJS.Platform,
    configuredUserDataDir: Optional<string>
  ): Promise<CdpExternalBrowserLauncherBrowser> {
    const executablePath = this.resolveExecutablePath(options.executablePath, platform)
    const timeoutMs = options.timeoutMs ?? BrowserTuning.externalBrowser.launchTimeoutMs
    let lastError: unknown = null

    for (
      let attempt = 1;
      attempt <= BrowserTuning.externalBrowser.launchMaxAttempts;
      attempt += 1
    ) {
      const userDataDir =
        configuredUserDataDir || (await this.mkdtemp(join(tmpdir(), 'velaros-cdp-browser-')))
      try {
        return await this.spawnAttempt({
          executablePath,
          userDataDir,
          ownsUserDataDir: !configuredUserDataDir,
          options,
          platform,
          timeoutMs,
        })
      } catch (error) {
        lastError = error
        if (!shouldRetryLaunchAttempt(error, attempt)) throw error

        this.log.debug('外部浏览器启动早退，准备重试', {
          attempt,
          maxAttempts: BrowserTuning.externalBrowser.launchMaxAttempts,
          error: AppError.from(error).message,
        })
        await this.sleep(BrowserTuning.externalBrowser.launchRetryDelayMs)
      }
    }

    throw AppError.from(lastError)
  }

  private async spawnAttempt(input: {
    executablePath: string
    userDataDir: string
    ownsUserDataDir: boolean
    options: CdpExternalBrowserLaunchOptions
    platform: NodeJS.Platform
    timeoutMs: number
  }): Promise<CdpExternalBrowserLauncherBrowser> {
    const { executablePath, userDataDir, ownsUserDataDir, options, platform, timeoutMs } = input
    const temporaryUserDataDir = ownsUserDataDir ? userDataDir : null
    const launchEnv = {
      ...process.env,
      ...(options.env ?? {}),
    }

    await this.unlink(devToolsActivePortPath(userDataDir, platform)).catch(() => {
      // arch-guard:silent-catch-ok 启动前清理允许文件不存在；新浏览器会写入自己的端口文件。
    })
    const child = this.spawn(
      executablePath,
      buildLaunchArgs(userDataDir, options, {
        env: launchEnv,
        platform,
      }),
      {
        detached: platform !== 'win32',
        env: launchEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )
    const stderr = captureChromeStderr(child)

    try {
      const activePort = await this.waitForDevToolsActivePort(
        child,
        userDataDir,
        platform,
        timeoutMs,
        stderr
      )
      const url = buildBrowserWebSocketUrl(activePort)
      const connection = await new CdpBrowserConnection().connect(url, {
        createSocket: this.createSocket,
        timeoutMs: BrowserTuning.externalBrowser.connectTimeoutMs,
      })
      this.log.info('拉起了外部浏览器', { userDataDir, url, temporary: ownsUserDataDir })
      return await this.remember(url, {
        connection,
        child,
        temporaryUserDataDir,
        downloadPath: options.downloadPath?.trim() || join(userDataDir, 'Downloads'),
        platform,
      })
    } catch (error) {
      this.disposeLaunchedBrowser(child, temporaryUserDataDir, platform)
      throw error
    }
  }

  /**
   * 记下一个新连上的浏览器：连接一断就划掉；设好下载目录。
   * 启动器在连的途中被释放了：断开连接、不记，抛出去（我们拉起的进程由拉起的那一步收）。
   */
  private async remember(
    url: string,
    browser: CdpExternalBrowserLauncherBrowser
  ): Promise<CdpExternalBrowserLauncherBrowser> {
    if (this.disposed) {
      browser.connection.dispose()
      throw new AppError('EXECUTION_ABORTED', '外部浏览器启动器已经释放。')
    }
    this.browsers.set(url, browser)
    browser.connection.onClose(() => this.forget(url, browser))
    if (browser.downloadPath) {
      await browser.connection.setDownloadBehavior(browser.downloadPath).catch((error) => {
        this.log.warn('外部浏览器的下载目录没设上，页面下载会落进浏览器自己的默认目录', {
          url,
          error: AppError.from(error).message,
        })
      })
    }
    return browser
  }

  /** 划掉一个浏览器（连接断了或收尾）：是我们拉起的就杀掉进程、删掉临时目录。只做一次。 */
  private forget(url: string, browser: CdpExternalBrowserLauncherBrowser): void {
    if (this.browsers.get(url) !== browser) return
    this.browsers.delete(url)
    if (browser.child)
      this.disposeLaunchedBrowser(browser.child, browser.temporaryUserDataDir, browser.platform)
  }

  /** 在浏览器里另开一个标签页，挂上会话、建驱动；交回的 dispose 只关这一页。 */
  private async openPage(
    browser: CdpExternalBrowserLauncherBrowser,
    options: CdpExternalBrowserLaunchOptions
  ): Promise<CdpExternalBrowserSession> {
    const { connection } = browser
    const url = options.url?.trim() || 'about:blank'
    const targetId = await connection.createPage(url)
    try {
      // 标签页目录只列这一页所在的浏览器上下文：用户自己的 Chrome 里别的配置、无痕窗口的标签页不给模型看。
      const pages = await connection.listPageTargets()
      const browserContextId = pages.find((page) => page.targetId === targetId)?.browserContextId
      const driver = new CdpBrowserPageDriver({
        transport: await connection.attach(targetId),
        initialUrl: URL.canParse(url) ? new URL(url).href : url,
        downloadPath: browser.downloadPath,
        targets: {
          targetId,
          list: () => connection.listPageTargets(browserContextId),
          attach: (id, attachOptions) => connection.attach(id, attachOptions),
        },
      })
      this.log.debug('给会话开了新标签页', { targetId, url })
      let disposed = false
      return {
        driver,
        dispose: () => {
          if (disposed) return
          disposed = true
          driver.dispose()
          void connection.closePage(targetId)
        },
      }
    } catch (error) {
      void connection.closePage(targetId)
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
    platform: NodeJS.Platform,
    timeoutMs: number,
    stderr: CdpChromeStderrDiagnostics
  ): Promise<CdpDevToolsActivePort> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() <= deadline) {
      if (isPresent(child.exitCode)) {
        await this.sleep(0)
        throw new AppError('EXECUTION_FAILED', formatChromeEarlyExitMessage(child, stderr))
      }

      const activePort = await this.readDevToolsActivePort(userDataDir, platform)
      if (activePort) return activePort

      await this.sleep(BrowserTuning.externalBrowser.pollIntervalMs)
    }

    throw new AppError('TIMEOUT', '等待外部浏览器 DevToolsActivePort 超时。')
  }

  /** 读一个用户数据目录里的调试端口文件；没有、读不了、写到一半都当没有。 */
  private async readDevToolsActivePort(
    userDataDir: string,
    platform: NodeJS.Platform
  ): Promise<Nullable<CdpDevToolsActivePort>> {
    const path = devToolsActivePortPath(userDataDir, platform)
    if (!this.existsSync(path)) return null
    try {
      return parseDevToolsActivePort(await this.readFile(path, 'utf8'))
    } catch {
      // arch-guard:silent-catch-ok DevToolsActivePort 在 Chrome 写入前会反复缺席，轮询路径不刷日志。
      return null
    }
  }

  private disposeLaunchedBrowser(
    child: CdpExternalBrowserChildProcess,
    tempUserDataDir: Nullable<string>,
    platform: NodeJS.Platform
  ): void {
    // 进程已经退了就不再发信号：pid 可能已经被别的进程重用。
    const running = !isPresent(child.exitCode)
    if (!child.killed && running) {
      const killedProcessGroup = this.killLaunchedBrowserProcessGroup(child, platform)
      if (!killedProcessGroup) {
        child.kill('SIGTERM')
      }
    }
    if (!tempUserDataDir) return

    const remove = (): void => {
      void this.rm(tempUserDataDir, { recursive: true, force: true }).catch((error) => {
        this.log.debug('临时配置目录没删掉', {
          path: tempUserDataDir,
          error: AppError.from(error).message,
        })
      })
    }
    // Chrome 退出途中还在往配置目录里写：等它退了再删，当场删会删不干净。
    if (running && child.once) child.once('exit', remove)
    else remove()
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
