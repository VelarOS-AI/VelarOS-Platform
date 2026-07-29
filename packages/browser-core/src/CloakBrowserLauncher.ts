import { rm as defaultRm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isNonBlankString, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  CdpBrowserPageDriver,
  type CdpBrowserPageDriverTransport,
} from './CdpBrowserPageDriver'
import type {
  CdpExternalBrowserLaunchOptions,
  CdpExternalBrowserSession,
} from './CdpExternalBrowserLauncher'
import {
  type CloakBrowserRuntimeProvider,
  cloakBrowserRuntimeResolver,
  type CloakBrowserRuntimeSpec,
} from './CloakBrowserRuntimeResolver'

interface CloakBrowserModule {
  launch(options?: Record<string, unknown>): Promise<CloakBrowser>
}

interface CloakBrowser {
  newPage(): Promise<CloakBrowserPage>
  close(): Promise<void>
}

interface CloakBrowserPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  url(): string
  title(): Promise<string>
  context(): CloakBrowserContext
  isClosed?: () => boolean
  close?: () => Promise<void>
}

interface CloakBrowserContext {
  newCDPSession?: (page: CloakBrowserPage) => Promise<CloakBrowserCdpSession>
}

interface CloakBrowserCdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on?: (method: string, listener: (params: unknown) => void) => unknown
  off?: (method: string, listener: (params: unknown) => void) => unknown
  detach?: () => Promise<void>
}

interface CloakBrowserLauncherDependencies {
  runtimeResolver?: LooseOptional<CloakBrowserRuntimeProvider>
  loadModule?: LooseOptional<(runtime: CloakBrowserRuntimeSpec) => Promise<CloakBrowserModule>>
  rm?: LooseOptional<(path: string, options: { recursive: true; force: true }) => Promise<void>>
}

class PlaywrightCdpSessionTransport implements CdpBrowserPageDriverTransport {
  private readonly subscriptions: Array<() => void> = []
  private readonly closeListeners = new Set<() => void>()
  private disposed = false

  constructor(private readonly session: CloakBrowserCdpSession) {}

  public send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.disposed) {
      throw new AppError('EXECUTION_ABORTED', 'CloakBrowser CDP session disposed.')
    }
    return this.session.send<T>(method, params)
  }

  public onEvent<T = unknown>(method: string, listener: (params: T) => void): () => void {
    const wrapped = (params: unknown): void => {
      listener(params as T)
    }
    this.session.on?.(method, wrapped)
    const unsubscribe = (): void => {
      this.session.off?.(method, wrapped)
    }
    this.subscriptions.push(unsubscribe)
    return unsubscribe
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions.splice(0)) {
      unsubscribe()
    }
    for (const listener of [...this.closeListeners]) {
      listener()
    }
    this.closeListeners.clear()
    void this.session.detach?.().catch(() => undefined)
  }
}

class CloakBrowserLauncher {
  private readonly runtimeResolver: CloakBrowserRuntimeProvider
  private readonly loadModule: (runtime: CloakBrowserRuntimeSpec) => Promise<CloakBrowserModule>
  private readonly rm: (path: string, options: { recursive: true; force: true }) => Promise<void>

  constructor(dependencies: CloakBrowserLauncherDependencies = {}) {
    this.runtimeResolver = dependencies.runtimeResolver ?? cloakBrowserRuntimeResolver
    this.loadModule = dependencies.loadModule ?? defaultLoadCloakBrowserModule
    this.rm = dependencies.rm ?? defaultRm
  }

  public async launch(
    options: CdpExternalBrowserLaunchOptions = {}
  ): Promise<CdpExternalBrowserSession> {
    const runtime = this.runtimeResolver.resolve()
    if (!runtime) {
      throw new AppError(
        'VALIDATION',
        '内置 CloakBrowser runtime 未找到。请确认应用构建产物包含 out/resources/cloakbrowser/cloakbrowser-<platform>-<arch> 资源包。'
      )
    }

    const module = await this.loadModule(runtime)
    const launchUrl = options.url?.trim()
    const userDataDir =
      options.userDataDir?.trim() || join(tmpdir(), `velaros-cloak-browser-${Date.now()}`)
    const ownsUserDataDir = !options.userDataDir?.trim()
    let browser: Nullable<CloakBrowser> = null
    let page: Nullable<CloakBrowserPage> = null
    let hostDisposed = false

    try {
      // launch 放进 try：浏览器可执行文件缺失时 Playwright 会抛错，
      // 统一收敛成 AppError('EXECUTION_FAILED')，而非泄漏原始错误。
      browser = await this.withRuntimeEnvironment(
        {
          ...runtime.env,
          ...(options.env ?? {}),
        },
        () => module.launch(this.buildLaunchOptions(options))
      )
      page = await browser.newPage()
      if (isNonBlankString(launchUrl)) {
        await page.goto(launchUrl, { waitUntil: 'load', timeout: options.timeoutMs })
      }
      const cdpSession = await this.createCdpSession(page)
      const transport = new PlaywrightCdpSessionTransport(cdpSession)
      const driver = new CdpBrowserPageDriver({
        transport,
        initialUrl: page.url(),
        initialTitle: await page.title().catch(() => ''),
        downloadPath: options.downloadPath,
        onDispose: () => {
          void page?.close?.().catch(() => undefined)
        },
      })
      const disposeHost = (): void => {
        if (hostDisposed) return
        hostDisposed = true
        void browser?.close().catch(() => undefined)
        if (ownsUserDataDir) {
          void this.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }

      return {
        driver,
        port: 0,
        userDataDir,
        webSocketDebuggerUrl: 'cloakbrowser://playwright',
        dispose: disposeHost,
      }
    } catch (error) {
      await page?.close?.().catch(() => undefined)
      await browser?.close().catch(() => undefined)
      if (ownsUserDataDir) {
        await this.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
      }
      throw AppError.from(error, 'EXECUTION_FAILED')
    }
  }

  private buildLaunchOptions(options: CdpExternalBrowserLaunchOptions): Record<string, unknown> {
    const launchOptions: Record<string, unknown> = {
      headless: true,
    }
    if (options.args) launchOptions.args = options.args
    if (options.timeoutMs) launchOptions.timeout = options.timeoutMs
    if (options.executablePath?.trim()) launchOptions.executablePath = options.executablePath.trim()

    return launchOptions
  }

  private async createCdpSession(page: CloakBrowserPage): Promise<CloakBrowserCdpSession> {
    const context = page.context()
    if (!context.newCDPSession) {
      throw new AppError(
        'VALIDATION',
        'CloakBrowser Playwright context does not expose newCDPSession.'
      )
    }

    return context.newCDPSession(page)
  }

  private async withRuntimeEnvironment<T>(
    env: Record<string, string | undefined>,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key])
      if (isPresent(value)) {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    }

    try {
      return await action()
    } finally {
      for (const [key, value] of previous) {
        if (isPresent(value)) {
          process.env[key] = value
        } else {
          delete process.env[key]
        }
      }
    }
  }
}

const defaultLoadCloakBrowserModule = async (
  runtime: CloakBrowserRuntimeSpec
): Promise<CloakBrowserModule> => {
  try {
    return (await import(pathToFileURL(runtime.moduleEntry).href)) as unknown as CloakBrowserModule
  } catch (error) {
    throw new AppError(
      'VALIDATION',
      '内置 CloakBrowser runtime 加载失败。请确认资源包包含 cloakbrowser 与 playwright-core。',
      error
    )
  }
}

export {
  CloakBrowserLauncher,
  type CloakBrowserLauncherDependencies,
  PlaywrightCdpSessionTransport,
}
