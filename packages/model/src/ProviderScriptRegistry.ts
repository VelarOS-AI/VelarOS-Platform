import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

import {
  isArray,
  isBlank,
  isBoolean,
  isEmpty,
  isFalse,
  isFunction,
  isNonBlankString,
  isPlainObject,
  isPresent,
  isString,
  optionalWhen,
  toNullable,
  toOptional,
  trimmedStringOrEmpty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ModelRequestOptions,
  ProviderModelCatalogEntry,
  ProviderScriptManifest,
  ValidateProviderRuntimeRequest,
} from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'
import { ModelProviderOperationalManifests } from './ProviderManifest'
import {
  type ProviderScriptRegistryPort,
  type ProviderScriptRuntimeMetadata,
  toPositiveInteger,
} from './ProviderScriptRegistryPort'
import {
  isReasoningDisabledByLevel,
  mergeOpenRouterReasoning,
  resolveReasoningBudget,
  resolveReasoningEffort,
} from './ThinkingDepthModelOptions'

type ProviderScriptConfigEntry =
  | string
  | {
      path?: LooseOptional<string>
      enabled?: LooseOptional<boolean>
    }

interface ProviderScriptDevConfig {
  providerScripts?: LooseOptional<{
    enabled?: LooseOptional<boolean>
    scripts?: LooseOptional<ProviderScriptConfigEntry[]>
  }>
  scripts?: LooseOptional<ProviderScriptConfigEntry[]>
}

export interface ProviderScriptHostBridge {
  openExternal(url: string): Promise<void> | void
  getUserDataPath(): string
  getAppVersion(): string
}

export interface ProviderScriptRegistryOptions {
  cwd?: string
  homeDir?: string
  configPaths?: readonly string[]
  hostBridge?: Partial<ProviderScriptHostBridge>
  clearRequireCache?: boolean
}

export interface ProviderScriptInput {
  config: ModelAdapterConfig
  helpers: ProviderScriptHelpers
  runtimeMetadata?: LooseOptional<ProviderScriptRuntimeMetadata>
}

export interface ProviderScriptRuntimeInput {
  provider: ChatProviderId
  apiKey: string
  baseURL: string
  defaultModel?: LooseOptional<string>
  purpose?: LooseOptional<ListProviderModelsRequest['purpose']>
  model?: LooseOptional<string>
  config?: LooseOptional<ModelAdapterConfig>
  helpers: ProviderScriptHelpers
}

export interface ProviderScriptHelpers {
  createOpenAI: typeof createOpenAI
  createAnthropic: typeof createAnthropic
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI
  fetch: typeof fetch
  require: NodeRequire
  hostRequire: NodeRequire
  log: ReturnType<typeof logRuntime.tag>
  paths: {
    cwd: string
    homeDir: string
    configPath: string
    configDir: string
    velarosDir: string
    scriptPath: string
    scriptDir: string
  }
  host: {
    openExternal: ProviderScriptHostBridge['openExternal']
    getUserDataPath: ProviderScriptHostBridge['getUserDataPath']
    getAppVersion: ProviderScriptHostBridge['getAppVersion']
  }
  reasoning: {
    isReasoningDisabledByLevel: typeof isReasoningDisabledByLevel
    mergeOpenRouterReasoning: typeof mergeOpenRouterReasoning
    resolveReasoningBudget: typeof resolveReasoningBudget
    resolveReasoningEffort: typeof resolveReasoningEffort
  }
  AppError: typeof AppError
}

export interface ProviderScriptDefinition {
  manifest: ProviderScriptManifest
  createLanguageModelFactory?: (input: ProviderScriptInput) => LanguageModelFactory
  createEmbeddingRequest?: (
    input: ProviderScriptInput & {
      model: string
      texts: string[]
    }
  ) => EmbeddingRequest
  validate?: (input: ProviderScriptRuntimeInput) => Promise<void> | void
  listModels?: (
    input: ProviderScriptRuntimeInput
  ) => Promise<ProviderModelCatalogEntry[]> | ProviderModelCatalogEntry[]
  resolveRuntimeMetadata?: (
    input: ProviderScriptRuntimeInput
  ) => Promise<ProviderScriptRuntimeMetadata> | ProviderScriptRuntimeMetadata
  fetchTavily?: (input: {
    path: '/api/tavily/search' | '/api/tavily/extract'
    body: Record<string, unknown>
    signal?: AbortSignal
    helpers: ProviderScriptHelpers
  }) => Promise<unknown>
}

export interface LoadedProviderScript {
  providerId: ChatProviderId
  label: string
  manifest: ProviderScriptManifest
  scriptPath: string
  configPath: string
  definition: ProviderScriptDefinition
  helpers: ProviderScriptHelpers
}

const log = logRuntime.tag('ProviderScriptRegistry')
const ProviderScriptRequire = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
)
const BuiltInProviderIds = new Set<string>(
  ModelProviderOperationalManifests.map((manifest) => manifest.id)
)

function resolveProviderScriptDevConfigCandidates(
  cwd = process.cwd(),
  homeDir = homedir()
): string[] {
  return [join(cwd, '.velaros/dev.json'), join(homeDir, '.velaros/dev.json')]
}

/**
 * 导览（§5.3b ④安全门 / ②生命周期 / ⑥非显然妥协）——磁盘 provider script 的加载与执行。
 *
 * **信任模型（改这个文件前必须先认同这一条）**：这里用 `runInThisContext` / `require` 执行脚本，
 * 脚本因此拿到**与宿主进程同权**的能力（fs、网络、`hostRequire` 拿宿主 node_modules）。这是刻意的
 * ——provider script 要能自带 SDK、读证书、开系统浏览器做 OAuth，沙箱化会直接废掉这个能力。
 * 换取安全的前提只有一条：**入口必须是显式登记**。当前两个入口各自的门是：
 * - `.velaros/dev.json`（`configPaths`）——开发者本机文件，产品分发包里不存在；
 * - `registerSource()`——**内存注册，本方法不做任何鉴权**，来源鉴权/签名/解密全部由调用方负责
 *   （插件安装链）。往这里加"从网络拉一段源码就注册"的便捷入口 = 打开远程代码执行。
 * 用户随手上传的 JS 走的是另一条路（`UserJsModelAdapter` 的 VM 沙箱），别把两者的判据互相借用。
 *
 * **加载生命周期**：`loaded` 是一次性闸（懒加载，首次公开方法触发 `ensureLoaded`）；
 * 任何会改变来源的操作（`configureHost` / `configureSources` / `reload`）都必须走
 * `resetLoadedState()` 把 `loaded`、`activeConfigPath`、`scripts` 三者一起清零——只清其中一个会留下
 * "指向旧 config 的已加载脚本"这种半态。
 *
 * **失败方向**：加载期任一脚本抛错即整体抛（§2.8 判据边界——provider script 是显式登记的，
 * 静默跳过会让"我明明配了却没生效"变成不可诊断）；而运行期的 host bridge 缺席只降级记账
 * （`openExternal` 警告 / userData 与 version 回退默认值），因为宿主可能还没注入完。
 */
class ProviderScriptRegistry implements ProviderScriptRegistryPort {
  private cwd: string
  private homeDir: string
  private configPaths: readonly string[]
  private readonly clearRequireCache: boolean
  private hostBridge: Partial<ProviderScriptHostBridge>
  private loaded = false
  private activeConfigPath: Nullable<string> = null
  private scripts = new Map<ChatProviderId, LoadedProviderScript>()

  constructor(options: ProviderScriptRegistryOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.homeDir = options.homeDir ?? homedir()
    this.configPaths =
      options.configPaths ?? resolveProviderScriptDevConfigCandidates(this.cwd, this.homeDir)
    this.hostBridge = options.hostBridge ?? {}
    this.clearRequireCache = options.clearRequireCache ?? true
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
      options.configPaths ?? resolveProviderScriptDevConfigCandidates(this.cwd, this.homeDir)
    this.resetLoadedState()
  }

  public reload(): void {
    this.resetLoadedState()
    this.ensureLoaded()
  }

  /**
   * 注册只存在于内存中的受信 provider 源码。调用方负责来源鉴权、密文校验与解密；
   * 本方法不会把明文写回磁盘。
   */
  public registerSource(input: {
    source: string
    scriptPath: string
    configPath?: string
  }): ChatProviderId {
    this.ensureLoaded()
    const scriptPath = resolve(input.scriptPath)
    const configPath = input.configPath ? resolve(input.configPath) : scriptPath
    try {
      const scriptRequire = createRequire(scriptPath)
      const module = { exports: {} as unknown }
      const wrapper = runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {\n${input.source}\n})`,
        { filename: scriptPath }
      ) as (
        exports: unknown,
        require: NodeRequire,
        module: { exports: unknown },
        filename: string,
        directory: string
      ) => void
      wrapper(module.exports, scriptRequire, module, scriptPath, dirname(scriptPath))
      return this.registerExportedDefinition({
        exported: module.exports,
        configPath,
        velarosDir: dirname(configPath),
        scriptPath,
      })
    } catch (error) {
      throw new AppError(
        'VALIDATION',
        `加载内存 provider script 失败：${scriptPath}: ${AppError.getMessage(error)}`
      )
    }
  }

  public unregisterProvider(provider: ChatProviderId): boolean {
    this.ensureLoaded()
    return this.scripts.delete(provider)
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
        'VALIDATION',
        `${provider} 需要先在 .velaros/dev.json 注入 provider script。`
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
          'VALIDATION',
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
    model: string
  ): Promise<Nullable<ProviderScriptRuntimeMetadata>> {
    const script = this.requireProviderScript(config.provider)
    if (!script.definition.resolveRuntimeMetadata) return null

    return normalizeRuntimeMetadata(
      await script.definition.resolveRuntimeMetadata({
        provider: config.provider,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: model,
        model,
        config,
        helpers: script.helpers,
      })
    )
  }

  public async fetchTavily(
    path: '/api/tavily/search' | '/api/tavily/extract',
    body: Record<string, unknown>,
    provider: ChatProviderId,
    signal?: AbortSignal
  ): Promise<unknown> {
    const script = this.requireProviderScript(provider)
    if (!script.definition.fetchTavily)
      throw new AppError('VALIDATION', `${provider} provider script 未提供 fetchTavily。`)

    return script.definition.fetchTavily({
      path,
      body,
      signal,
      helpers: script.helpers,
    })
  }

  private ensureLoaded(): void {
    if (this.loaded) return

    this.loaded = true
    const configPath = this.configPaths.find((candidate) => existsSync(candidate))
    if (!configPath) return

    this.activeConfigPath = configPath
    const config = this.readConfig(configPath)
    const scriptEntries = this.readEnabledScriptEntries(config)
    scriptEntries.forEach((entry) => this.loadScript(configPath, entry))
  }

  private resetLoadedState(): void {
    this.loaded = false
    this.activeConfigPath = null
    this.scripts = new Map()
  }

  private readConfig(configPath: string): ProviderScriptDevConfig {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      return isPlainObject(parsed) ? (parsed as ProviderScriptDevConfig) : {}
    } catch (error) {
      throw new AppError(
        'VALIDATION',
        `读取 provider script 配置失败：${configPath}: ${AppError.getMessage(error)}`
      )
    }
  }

  private readEnabledScriptEntries(config: ProviderScriptDevConfig): string[] {
    const providerScripts = isPlainObject(config.providerScripts) ? config.providerScripts : null
    if (isFalse(providerScripts?.enabled)) return []

    const scripts = providerScripts?.scripts ?? config.scripts ?? []
    if (!isArray(scripts)) return []

    return scripts.flatMap((entry): string[] => {
      if (isString(entry)) return isBlank(entry.trim()) ? [] : [entry.trim()]
      if (!isPlainObject(entry) || isFalse(entry.enabled)) return []

      const scriptPath = entry.path?.trim() ?? ''
      return isBlank(scriptPath) ? [] : [scriptPath]
    })
  }

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
        'VALIDATION',
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
    const definition = this.normalizeLoadedDefinition(input.exported, helpers)
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
    log.info('provider script loaded', {
      providerId,
      scriptPath: input.scriptPath,
    })
    return providerId
  }

  private normalizeLoadedDefinition(
    exported: unknown,
    helpers: ProviderScriptHelpers
  ): ProviderScriptDefinition {
    const candidate =
      isPlainObject(exported) && isPlainObject(exported.default) ? exported.default : exported

    if (isFunction(candidate)) return parseProviderScriptDefinition(
        candidate({ helpers }),
        'provider script factory 必须返回合法定义对象。'
      )

    if (!isPlainObject(candidate)) {
      throw new AppError('VALIDATION', 'provider script 必须导出对象。')
    }

    const factory = (candidate as { createProviderScript?: unknown }).createProviderScript
    if (isFunction(factory)) return parseProviderScriptDefinition(
        factory({ helpers }),
        'createProviderScript 必须返回合法定义对象。'
      )

    return parseProviderScriptDefinition(candidate, 'provider script 必须导出合法定义对象。')
  }

  private createHelpers(input: {
    configPath: string
    velarosDir: string
    scriptPath: string
  }): ProviderScriptHelpers {
    const scriptRequire = createRequire(input.scriptPath)
    const log = logRuntime.tag(`ProviderScript.${input.scriptPath}`)
    return {
      createOpenAI,
      createAnthropic,
      createGoogleGenerativeAI,
      fetch: globalThis.fetch.bind(globalThis),
      require: scriptRequire,
      hostRequire: ProviderScriptRequire,
      log,
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
        openExternal: (url) => this.openExternal(url),
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

  private async openExternal(url: string): Promise<void> {
    if (this.hostBridge.openExternal) {
      await this.hostBridge.openExternal(url)
      return
    }

    log.warn('provider script requested openExternal before host bridge was set', {
      url,
    })
  }

  private getUserDataPath(): string {
    try {
      const path = this.hostBridge.getUserDataPath?.()
      if (isNonBlankString(path)) return path
    } catch (error) {
      log.warn('provider script host userData path unavailable', { error })
    }

    return join(this.homeDir, '.velaros')
  }

  private getAppVersion(): string {
    try {
      return this.hostBridge.getAppVersion?.() || '0.0.0'
    } catch (error) {
      log.warn('provider script host app version unavailable', { error })
      return '0.0.0'
    }
  }

}

class ProviderScriptModelAdapter extends ModelAdapter {
  constructor(
    private readonly registry: ProviderScriptRegistry,
    providers: ModelProviderCollection
  ) {
    super([], providers)
  }

  public override supports(provider: ChatProviderId): boolean {
    return this.registry.supportsProvider(provider)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const script = this.registry.requireProviderScript(config.provider)
    const createFactory = script.definition.createLanguageModelFactory
    if (!createFactory) {
      throw new AppError(
        'VALIDATION',
        `${config.provider} provider script 缺少 createLanguageModelFactory。`
      )
    }

    const factory = createFactory({
      config,
      helpers: script.helpers,
      runtimeMetadata: config.providerScriptRuntimeMetadata,
    })
    if (!isFunction(factory)) {
      throw new AppError(
        'VALIDATION',
        `${config.provider} provider script createLanguageModelFactory 必须返回函数。`
      )
    }

    return (modelId, options) =>
      applyPromptCacheProviderOptions(factory(modelId, options) as LanguageModel)
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    const script = this.registry.requireProviderScript(config.provider)
    const createEmbeddingRequest = script.definition.createEmbeddingRequest
    if (!createEmbeddingRequest) return super.createEmbeddingRequest(config, model, texts)

    return createEmbeddingRequest({
      config,
      helpers: script.helpers,
      runtimeMetadata: config.providerScriptRuntimeMetadata,
      model,
      texts,
    })
  }
}

function normalizeProviderScriptModels(value: unknown): ProviderModelCatalogEntry[] {
  if (!isArray(value)) return []

  return value.flatMap((item): ProviderModelCatalogEntry[] => {
    if (!isPlainObject(item)) return []
    const id = String(item.id ?? '').trim()
    if (isBlank(id)) return []

    const label = String(item.label ?? id).trim() || id
    const contextWindow = toPositiveInteger(item.contextWindow)
    const inputModalities = normalizeModelInputModalities(item.inputModalities)
    const available = optionalWhen(isBoolean, item.available)
    const minPlan = optionalWhen(isString, item.minPlan)
    return [
      {
        id,
        label,
        contextWindow: toOptional(contextWindow),
        inputModalities,
        available,
        minPlan,
      },
    ]
  })
}

function normalizeRuntimeMetadata(value: unknown): Nullable<ProviderScriptRuntimeMetadata> {
  if (!isPlainObject(value)) return null

  const contextWindow = toPositiveInteger(value.contextWindow)
  return {
    model: optionalWhen(isString, value.model),
    providerModel: optionalWhen(isString, value.providerModel),
    contextWindow: toOptional(contextWindow),
    inputModalities: normalizeModelInputModalities(value.inputModalities),
    fallbackReason: optionalWhen(isString, value.fallbackReason),
    config: value.config,
    modelRequestOptions: isPlainObject(value.modelRequestOptions)
      ? (value.modelRequestOptions as ModelRequestOptions)
      : undefined,
  }
}

function normalizeModelInputModalities(
  value: unknown
): Array<'text' | 'image' | 'audio'> | undefined {
  if (!isArray(value)) return undefined

  const modalities = [...new Set(value.filter(
    (entry): entry is 'text' | 'image' | 'audio' =>
      entry === 'text' || entry === 'image' || entry === 'audio'
  ))]
  return !isEmpty(modalities) ? modalities : undefined
}

const ProviderScriptDefinitionOptionalMembers = [
  'createLanguageModelFactory',
  'createEmbeddingRequest',
  'validate',
  'listModels',
  'resolveRuntimeMetadata',
  'fetchTavily',
] as const

/**
 * 模型脚本输出的结构守卫（§12.5 共享守卫）：断言导出为普通对象、且可选成员若存在必为函数。
 * 函数签名无法运行时校验，manifest 交由 normalizeProviderScriptManifest 权威复核；本守卫替代
 * 双重断言跳板，让消费方在边界解析一次即拿到受信定义（§12.5 正解）。
 */
function isProviderScriptDefinitionShape(value: unknown): value is ProviderScriptDefinition {
  if (!isPlainObject(value)) return false
  for (const key of ProviderScriptDefinitionOptionalMembers) {
    const member = value[key]
    if (isPresent(member) && !isFunction(member)) return false
  }
  return true
}

function parseProviderScriptDefinition(value: unknown, message: string): ProviderScriptDefinition {
  if (!isProviderScriptDefinitionShape(value)) throw new AppError('VALIDATION', message)
  return value
}

function normalizeInjectedProviderId(value: unknown): Nullable<ChatProviderId> {
  const providerId = trimmedStringOrEmpty(value)
  if (!/^[a-z][a-z0-9._-]{1,63}$/u.test(providerId)) return null
  if (BuiltInProviderIds.has(providerId)) return null

  return providerId as ChatProviderId
}

function normalizeProviderScriptManifest(value: unknown): ProviderScriptManifest {
  if (!isPlainObject(value)) throw new AppError('VALIDATION', 'provider script 缺少 manifest。')

  const id = normalizeInjectedProviderId(value.id)
  if (!id)
    throw new AppError('VALIDATION', 'provider script manifest.id 无效或与内置 provider 冲突。')

  const label = trimmedStringOrEmpty(value.label)
  const description = trimmedStringOrEmpty(value.description)
  const defaultModel = trimmedStringOrEmpty(value.defaultModel)
  const models = normalizeProviderScriptModels(value.models)
  if (!label || !description || !defaultModel || isEmpty(models))
    throw new AppError(
      'VALIDATION',
      'provider script manifest 必须声明 label、description、defaultModel 和 models。'
    )
  if (!models.some((model) => model.id === defaultModel))
    throw new AppError('VALIDATION', 'provider script manifest.defaultModel 必须存在于 models。')

  return {
    id,
    label,
    description,
    defaultBaseURL: trimmedStringOrEmpty(value.defaultBaseURL),
    defaultApiKey: trimmedStringOrEmpty(value.defaultApiKey),
    apiKeyOptional: optionalWhen(isBoolean, value.apiKeyOptional, true),
    baseURLConfigurable: optionalWhen(isBoolean, value.baseURLConfigurable, false),
    enabledByDefault: optionalWhen(isBoolean, value.enabledByDefault, true),
    defaultModel,
    models,
    embeddingModel: optionalTrimmedString(value.embeddingModel),
    embeddingModelLocked: optionalWhen(isBoolean, value.embeddingModelLocked),
    inlineCompletionModel: optionalTrimmedString(value.inlineCompletionModel),
  }
}

function optionalTrimmedString(value: unknown): string | undefined {
  const normalized = trimmedStringOrEmpty(value)
  return normalized || undefined
}

export {
  ProviderScriptModelAdapter,
  ProviderScriptRegistry,
  resolveProviderScriptDevConfigCandidates,
}
