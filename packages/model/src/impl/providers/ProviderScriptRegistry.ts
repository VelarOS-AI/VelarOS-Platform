import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'

import { isNonBlankString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { ModelErrorCodes } from '../../contract/constants.js'
import type {
  ProviderScriptHostBridge,
  ProviderScriptRegistryOptions,
} from '../../contract/requires'
import type { ModelAdapterConfig } from '../../types/adapters'
import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ProviderModelCatalogEntry,
  ProviderScriptManifest,
  ProviderScriptRuntimeMetadata,
  ValidateProviderRuntimeRequest,
} from '../../types/model'
import type { LoadedProviderScript, ProviderScriptHelpers } from '../../types/script-authoring'
import type {
  ProviderScriptRegistryPort,
  RegisteredProviderScriptSource,
} from '../../types/scripts'
import { toPositiveInteger } from '../../utils/numbers'
import {
  normalizeLoadedDefinition,
  normalizeProviderScriptManifest,
  normalizeProviderScriptModels,
  normalizeRuntimeMetadata,
  providerScriptDevConfigCandidates,
  readEnabledScriptEntries,
  readProviderScriptDevConfig,
} from '../../utils/scripts/provider-scripts'
import { ModelTuning } from '../../utils/tuning'
import {
  isReasoningDisabledByLevel,
  mergeOpenRouterReasoning,
  resolveReasoningBudget,
  resolveReasoningEffort,
} from '../../utils/wire/reasoning'

/**
 * 磁盘与内存 provider script 的注册表。
 *
 * 导览（§5.3b ④安全门 / ②生命周期 / ⑥非显然妥协）——磁盘 provider script 的加载与执行。
 *
 * **信任模型（改这个文件前必须先认同这一条）**：这里用 `runInThisContext` / `require` 执行脚本，
 * 脚本因此拿到**与宿主进程同权**的能力（fs、网络、`hostRequire` 拿宿主 node_modules）。这是刻意的
 * ——provider script 要能自带 SDK、读证书、开系统浏览器做 OAuth，沙箱化会直接废掉这个能力。
 * 换取安全的前提只有一条：**入口必须是显式登记**。当前两个入口各自的门是：
 * - 宿主给的 `configPaths`（缺省是 `.velaros/dev.json`）——开发者本机文件，产品分发包里不存在；
 * - `registerSource()`——**内存注册，本方法不做任何鉴权**，来源鉴权/签名/解密全部由调用方负责
 *   （插件安装链）。往这里加"从网络拉一段源码就注册"的便捷入口 = 打开远程代码执行。
 * 用户随手上传的 JS 走的是另一条路（`UserJsModelAdapter` 的 VM 沙箱），别把两者的判据互相借用。
 */
export interface ProviderScriptRegistryApi extends ProviderScriptRegistryPort {
  /** 宿主注入桥之后调一次；会清掉已加载状态，下一次读取重新加载。 */
  configureHost(hostBridge: Partial<ProviderScriptHostBridge>): void
  /** 换一组配置来源；会清掉已加载状态，内存来源不受影响。 */
  configureSources(
    options: Pick<ProviderScriptRegistryOptions, 'configPaths' | 'cwd' | 'homeDir'>
  ): void
  /** 立刻清空并重新加载。 */
  reload(): void
  /**
   * 注册只存在于内存中的受信 provider 源码。
   *
   * 调用方负责来源鉴权、密文校验与解密；本方法不会把明文写回磁盘，
   * 注册结果由 `unregisterProvider` 之外的任何重配保留。
   */
  registerSource(input: { source: string; scriptPath: string; configPath?: string }): ChatProviderId
  /** 删掉一个 provider，连内存来源一起删；只删已加载的会在下次重配时被重放回来。 */
  unregisterProvider(provider: ChatProviderId): boolean
  /** 生效的配置文件路径；没有配置文件时返回 null。 */
  getActiveConfigPath(): Nullable<string>
}

/** 适配器取脚本用的包内接口；宿主面不开这个方法。 */
export interface ProviderScriptRegistryScripts {
  /** 取一份已加载的脚本；没有就按 providerScriptInvalid 抛。 */
  requireProviderScript(provider: ChatProviderId): LoadedProviderScript
}

export class ProviderScriptRegistry
  implements ProviderScriptRegistryApi, ProviderScriptRegistryScripts
{
  private readonly log = logRuntime.tag('ProviderScriptRegistry')
  private readonly hostRequire = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  )
  private cwd: string
  private homeDir: string
  private configPaths: readonly string[]
  private readonly clearRequireCache: boolean
  private readonly runtimeMetadataTimeoutMs: number
  private hostBridge: Partial<ProviderScriptHostBridge>
  private loaded = false
  private activeConfigPath: Nullable<string> = null
  private scripts = new Map<ChatProviderId, LoadedProviderScript>()
  /**
   * 内存来源是**另一条生命周期**：磁盘来源由 config 决定，重配一次就该整批重来；
   * `registerSource()` 注册的来源只由调用方（插件安装链）增删，重配宿主不能把它清掉——
   * 它没有落盘，清了就只能重装。所以 `resetLoadedState()` 只清 `scripts`，这张表留着，
   * 由 `ensureLoaded()` 在磁盘来源之后重放。
   */
  private readonly memorySources = new Map<ChatProviderId, RegisteredProviderScriptSource>()

  constructor(options: ProviderScriptRegistryOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.homeDir = options.homeDir ?? homedir()
    this.configPaths =
      options.configPaths ?? providerScriptDevConfigCandidates(this.cwd, this.homeDir)
    this.hostBridge = options.hostBridge ?? {}
    this.clearRequireCache = options.clearRequireCache ?? true
    this.runtimeMetadataTimeoutMs =
      toPositiveInteger(options.runtimeMetadataTimeoutMs)
      ?? ModelTuning.scripts.runtimeMetadataTimeoutMs
  }

  public configureHost(hostBridge: Partial<ProviderScriptHostBridge>): void {
    this.hostBridge = { ...this.hostBridge, ...hostBridge }
    this.resetLoadedState()
  }

  public configureSources(
    options: Pick<ProviderScriptRegistryOptions, 'configPaths' | 'cwd' | 'homeDir'>
  ): void {
    this.cwd = options.cwd ?? process.cwd()
    this.homeDir = options.homeDir ?? homedir()
    this.configPaths =
      options.configPaths ?? providerScriptDevConfigCandidates(this.cwd, this.homeDir)
    this.resetLoadedState()
  }

  public reload(): void {
    this.resetLoadedState()
    this.ensureLoaded()
  }

  public registerSource(input: {
    source: string
    scriptPath: string
    configPath?: string
  }): ChatProviderId {
    this.ensureLoaded()
    const scriptPath = resolve(input.scriptPath)
    const entry: RegisteredProviderScriptSource = {
      source: input.source,
      scriptPath,
      configPath: input.configPath ? resolve(input.configPath) : scriptPath,
    }
    const providerId = this.evaluateRegisteredSource(entry)
    this.memorySources.set(providerId, entry)
    return providerId
  }

  public unregisterProvider(provider: ChatProviderId): boolean {
    this.ensureLoaded()
    // 内存来源必须一起删：只删 `scripts` 的话，下一次重配会把它重放回来。
    const removedSource = this.memorySources.delete(provider)
    return this.scripts.delete(provider) || removedSource
  }

  public supportsProvider(provider: ChatProviderId): boolean {
    return !!this.getProviderScript(provider)
  }

  public getActiveConfigPath(): Nullable<string> {
    this.ensureLoaded()
    return this.activeConfigPath
  }

  public getProviderScript(provider: ChatProviderId): Nullable<LoadedProviderScript> {
    this.ensureLoaded()
    return toNullable(this.scripts.get(provider))
  }

  public listProviderManifests(): ProviderScriptManifest[] {
    this.ensureLoaded()
    return [...this.scripts.values()].map((script) => script.manifest)
  }

  public requireProviderScript(provider: ChatProviderId): LoadedProviderScript {
    const script = this.getProviderScript(provider)
    if (!script) {
      throw new AppError(
        ModelErrorCodes.providerScriptInvalid,
        `${provider} 需要先注入 provider script（开发机默认读 .velaros/dev.json）。`
      )
    }
    return script
  }

  public async validateProviderRuntime(
    request: ValidateProviderRuntimeRequest
  ): Promise<{ ok: boolean; message: Nullable<string> }> {
    try {
      const script = this.requireProviderScript(request.provider)
      if (script.definition.validate) {
        await script.definition.validate({
          provider: request.provider,
          apiKey: request.apiKey,
          baseURL: request.baseURL,
          defaultModel: request.defaultModel,
          helpers: script.helpers,
        })
      } else if (!script.definition.createLanguageModelFactory) {
        throw new AppError(
          ModelErrorCodes.providerScriptInvalid,
          `${request.provider} provider script 缺少 validate 或 createLanguageModelFactory。`
        )
      }

      return { ok: true, message: null }
    } catch (error) {
      return { ok: false, message: AppError.getMessage(error) }
    }
  }

  public async listProviderModels(
    request: ListProviderModelsRequest
  ): Promise<ProviderModelCatalogEntry[]> {
    const script = this.requireProviderScript(request.provider)
    if (!script.definition.listModels) return []

    return normalizeProviderScriptModels(
      await script.definition.listModels({
        provider: request.provider,
        apiKey: request.apiKey,
        baseURL: request.baseURL,
        defaultModel: request.defaultModel,
        purpose: request.purpose,
        helpers: script.helpers,
      })
    )
  }

  public async resolveRuntimeMetadata(
    config: ModelAdapterConfig,
    model: string,
    signal?: AbortSignal
  ): Promise<Nullable<ProviderScriptRuntimeMetadata>> {
    const script = this.requireProviderScript(config.provider)
    const resolveRuntimeMetadata = script.definition.resolveRuntimeMetadata
    if (!resolveRuntimeMetadata) return null

    const timers = new TimerScope({ name: 'ProviderScriptRuntimeMetadata' })
    try {
      return normalizeRuntimeMetadata(
        await timers.withTimeout(
          this.runtimeMetadataTimeoutMs,
          (operationSignal) =>
            resolveRuntimeMetadata({
              provider: config.provider,
              apiKey: config.apiKey,
              baseURL: config.baseURL,
              defaultModel: model,
              model,
              config,
              helpers: script.helpers,
              signal: operationSignal,
            }),
          {
            signal,
            timeoutMessage: `provider script 运行时元数据探测超时（${this.runtimeMetadataTimeoutMs}ms）。`,
          }
        )
      )
    } finally {
      timers.dispose()
    }
  }

  /**
   * **加载生命周期**：`loaded` 是一次性闸（懒加载，首次公开方法触发）；
   * 任何会改变来源的操作（`configureHost` / `configureSources` / `reload`）都必须走
   * `resetLoadedState()` 把 `loaded`、`activeConfigPath`、`scripts` 三者一起清零——只清其中一个会留下
   * "指向旧 config 的已加载脚本"这种半态。
   */
  private ensureLoaded(): void {
    if (this.loaded) return

    this.loaded = true
    const configPath = this.configPaths.find((candidate) => existsSync(candidate))
    if (configPath) {
      this.activeConfigPath = configPath
      const config = readProviderScriptDevConfig(configPath)
      readEnabledScriptEntries(config).forEach((entry) => this.loadScript(configPath, entry))
    }

    // 内存来源排在磁盘来源之后重放：同一个 provider id 上，后到的显式注册覆盖 config 里的条目；
    // 重新求值（而不是留住旧对象）是为了让 helpers 拿到这次重配后的 cwd/homeDir 与宿主桥。
    this.memorySources.forEach((entry) => this.evaluateRegisteredSource(entry))
  }

  /** 求值一份内存来源并登记；失败与磁盘脚本同口径：显式登记的来源加载不了就抛，不静默跳过。 */
  private evaluateRegisteredSource(entry: RegisteredProviderScriptSource): ChatProviderId {
    try {
      const scriptRequire = createRequire(entry.scriptPath)
      const module = { exports: {} as unknown }
      const wrapper = runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {\n${entry.source}\n})`,
        { filename: entry.scriptPath }
      ) as (
        exports: unknown,
        require: NodeRequire,
        module: { exports: unknown },
        filename: string,
        directory: string
      ) => void
      wrapper(module.exports, scriptRequire, module, entry.scriptPath, dirname(entry.scriptPath))
      return this.registerExportedDefinition({
        exported: module.exports,
        configPath: entry.configPath,
        velarosDir: dirname(entry.configPath),
        scriptPath: entry.scriptPath,
      })
    } catch (error) {
      throw new AppError(
        ModelErrorCodes.providerScriptInvalid,
        `加载内存 provider script 失败：${entry.scriptPath}: ${AppError.getMessage(error)}`
      )
    }
  }

  private resetLoadedState(): void {
    this.loaded = false
    this.activeConfigPath = null
    this.scripts = new Map()
  }

  /** 失败方向：加载期任一脚本抛错即整体抛——显式登记的来源静默跳过会让"我明明配了却没生效"不可诊断。 */
  private loadScript(configPath: string, configuredScriptPath: string): void {
    const velarosDir = dirname(configPath)
    const scriptPath = isAbsolute(configuredScriptPath)
      ? configuredScriptPath
      : resolve(velarosDir, configuredScriptPath)

    try {
      const scriptRequire = createRequire(scriptPath)
      const resolvedScriptPath = scriptRequire.resolve(scriptPath)
      if (this.clearRequireCache) delete scriptRequire.cache[resolvedScriptPath]

      const exported = scriptRequire(resolvedScriptPath) as unknown
      this.registerExportedDefinition({
        exported,
        configPath,
        velarosDir,
        scriptPath: resolvedScriptPath,
      })
    } catch (error) {
      throw new AppError(
        ModelErrorCodes.providerScriptInvalid,
        `加载 provider script 失败：${scriptPath}: ${AppError.getMessage(error)}`
      )
    }
  }

  private registerExportedDefinition(input: {
    exported: unknown
    configPath: string
    velarosDir: string
    scriptPath: string
  }): ChatProviderId {
    const helpers = this.createHelpers(input)
    const definition = normalizeLoadedDefinition(input.exported, helpers)
    const manifest = normalizeProviderScriptManifest(definition.manifest)
    const providerId = manifest.id

    this.scripts.set(providerId, {
      providerId,
      label: manifest.label,
      manifest,
      scriptPath: input.scriptPath,
      configPath: input.configPath,
      definition,
      helpers,
    })
    this.log.info('provider script loaded', {
      providerId,
      scriptPath: input.scriptPath,
    })
    return providerId
  }

  private createHelpers(input: {
    configPath: string
    velarosDir: string
    scriptPath: string
  }): ProviderScriptHelpers {
    const scriptRequire = createRequire(input.scriptPath)
    const scriptLog = logRuntime.tag(`ProviderScript.${input.scriptPath}`)
    return {
      createOpenAI,
      createAnthropic,
      createGoogleGenerativeAI,
      fetch: globalThis.fetch.bind(globalThis),
      require: scriptRequire,
      hostRequire: this.hostRequire,
      log: scriptLog,
      paths: {
        cwd: this.cwd,
        homeDir: this.homeDir,
        configPath: input.configPath,
        configDir: dirname(input.configPath),
        velarosDir: input.velarosDir,
        scriptPath: input.scriptPath,
        scriptDir: dirname(input.scriptPath),
      },
      host: {
        openExternal: (url: string) => this.openExternal(url),
        getUserDataPath: () => this.getUserDataPath(),
        getAppVersion: () => this.getAppVersion(),
      },
      reasoning: {
        isReasoningDisabledByLevel,
        mergeOpenRouterReasoning,
        resolveReasoningBudget,
        resolveReasoningEffort,
      },
      AppError,
    }
  }

  /** 失败方向：运行期的宿主桥缺席只降级记账，因为宿主可能还没注入完。 */
  private async openExternal(url: string): Promise<void> {
    if (this.hostBridge.openExternal) {
      await this.hostBridge.openExternal(url)
      return
    }

    this.log.warn('provider script requested openExternal before host bridge was set', {
      url,
    })
  }

  private getUserDataPath(): string {
    try {
      const path = this.hostBridge.getUserDataPath?.()
      if (isNonBlankString(path)) return path
    } catch (error) {
      this.log.warn('provider script host userData path unavailable', { error })
    }

    return join(this.homeDir, '.velaros')
  }

  private getAppVersion(): string {
    try {
      return this.hostBridge.getAppVersion?.() || '0.0.0'
    } catch (error) {
      this.log.warn('provider script host app version unavailable', { error })
      return '0.0.0'
    }
  }
}
