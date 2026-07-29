import { type Context, createContext, Script } from 'node:vm'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

import { isBlank, isFunction, isObject, isPresent,isString, isUndefined, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import type { ChatProviderId } from './ModelContracts'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import { ModelAdapter } from './ModelAdapter'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { applyPromptCacheProviderOptions } from './PromptCacheModelOptions'

interface UserAdapterFactoryInput {
  config: ModelAdapterConfig
  helpers: UserAdapterHelpers
}

interface UserAdapterExports {
  default?: Partial<UserAdapterExports>
  createLanguageModelFactory?: (input: UserAdapterFactoryInput) => LanguageModelFactory
  createEmbeddingRequest?: (
    input: UserAdapterFactoryInput & {
      model: string
      texts: string[]
    }
  ) => EmbeddingRequest
}

interface UserAdapterHelpers {
  createOpenAI: UserAdapterProviderFactory
  createAnthropic: UserAdapterProviderFactory
  createGoogleGenerativeAI: UserAdapterProviderFactory
}

type UserAdapterConsole = Pick<typeof console, 'debug' | 'error' | 'info' | 'log' | 'warn'>
type UserAdapterConsoleMethod = keyof UserAdapterConsole
type UserAdapterConsoleLogLevel = 'debug' | 'error' | 'info' | 'warn'
type UserAdapterProviderKind = 'openai' | 'anthropic' | 'google'
type UserAdapterProviderFactory = (settings?: UserAdapterProviderSettings) => UserAdapterProvider

interface UserAdapterProviderSettings {
  apiKey?: string
  baseURL?: string
  name?: string
}

interface UserAdapterProvider {
  (modelId: string): UserAdapterLanguageModelDescriptor
  chat(modelId: string): UserAdapterLanguageModelDescriptor
}

interface UserAdapterLanguageModelDescriptor {
  __velarosCustomAdapterDescriptor: 'language-model'
  providerKind: UserAdapterProviderKind
  modelId: string
  settings?: UserAdapterProviderSettings
}

interface EvaluatedUserAdapter {
  context: UserAdapterVmContext
  exports: UserAdapterExports
  helpers: UserAdapterHelpers
}

type UserAdapterVmCallable = (...args: never[]) => unknown

interface UserAdapterVmCall {
  fn: UserAdapterVmCallable
  arg0?: unknown
  arg1?: unknown
  result?: unknown
}

type UserAdapterVmContext = Context & {
  module: { exports: UserAdapterExports }
  exports: UserAdapterExports
  helpers: UserAdapterHelpers
  console: UserAdapterConsole
  __velarosUserAdapterCall__?: UserAdapterVmCall
  __velarosUserAdapterJson__?: string
  __velarosUserAdapterValue__?: unknown
}

const UserAdapterExecutionTimeoutMs = 1000
const UserAdapterEvaluationCacheLimit = 16
const UserAdapterFilename = 'velaros-custom-model-adapter.js'
const UserAdapterConsoleLog = logRuntime.tag('UserJsModelAdapter.console')
const UserAdapterConsoleLogLevels = {
  debug: 'debug',
  error: 'error',
  info: 'info',
  log: 'info',
  warn: 'warn',
} satisfies Record<UserAdapterConsoleMethod, UserAdapterConsoleLogLevel>
const UserAdapterContextSetupScript = new Script(
  `
"use strict";
(() => {
  const adapterModule = Object.create(null)
  adapterModule.exports = Object.create(null)
  globalThis.module = adapterModule
  globalThis.exports = adapterModule.exports
  const descriptorKey = "__velarosCustomAdapterDescriptor"
  const hardenFunction = (fn) => {
    Object.defineProperty(fn, "constructor", {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    })
    Object.setPrototypeOf(fn, null)
    return Object.freeze(fn)
  }
  const normalizeSettings = (settings) => {
    const output = Object.create(null)
    if (settings && typeof settings === "object") {
      for (const key of ["apiKey", "baseURL", "name"]) {
        const value = settings[key]
        if (typeof value === "string") output[key] = value
      }
    }
    return Object.freeze(output)
  }
  const createProvider = (providerKind, settings) => {
    const normalizedSettings = normalizeSettings(settings)
    const makeDescriptor = hardenFunction((modelId) =>
      Object.freeze(Object.assign(Object.create(null), {
        [descriptorKey]: "language-model",
        providerKind,
        modelId: String(modelId ?? ""),
        settings: normalizedSettings,
      }))
    )
    const provider = (modelId) => makeDescriptor(modelId)
    Object.defineProperty(provider, "chat", {
      configurable: false,
      enumerable: true,
      value: makeDescriptor,
      writable: false,
    })
    return hardenFunction(provider)
  }
  const createOpenAIProvider = hardenFunction((settings) => createProvider("openai", settings))
  const createAnthropicProvider = hardenFunction((settings) => createProvider("anthropic", settings))
  const createGoogleProvider = hardenFunction((settings) => createProvider("google", settings))
  globalThis.helpers = Object.freeze(Object.assign(Object.create(null), {
    createOpenAI: createOpenAIProvider,
    createAnthropic: createAnthropicProvider,
    createGoogleGenerativeAI: createGoogleProvider,
  }))
})()
`,
  {
    filename: UserAdapterFilename,
  }
)
const UserAdapterCallScripts = [
  new Script(
    `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  call.result = call.fn()
})()
`,
    { filename: UserAdapterFilename }
  ),
  new Script(
    `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  call.result = call.fn(call.arg0)
})()
`,
    { filename: UserAdapterFilename }
  ),
  new Script(
    `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  call.result = call.fn(call.arg0, call.arg1)
})()
`,
    { filename: UserAdapterFilename }
  ),
]
const UserAdapterJsonCloneScript = new Script(
  `
"use strict";
JSON.parse(globalThis.__velarosUserAdapterJson__)
`,
  { filename: UserAdapterFilename }
)
const UserAdapterJsonStringifyScript = new Script(
  `
"use strict";
JSON.stringify(globalThis.__velarosUserAdapterValue__)
`,
  { filename: UserAdapterFilename }
)

/** 用户上传 JS adapter，用于接入未内置的模型供应商。 */
class UserJsModelAdapter extends ModelAdapter {
  private readonly evaluatedAdapterCache = new Map<string, EvaluatedUserAdapter>()

  constructor(providerIds: readonly ChatProviderId[], providers: ModelProviderCollection) {
    super(providerIds, providers)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const adapter = this.evaluateAdapter(config)
    const createFactory =
      adapter.exports.createLanguageModelFactory ??
      adapter.exports.default?.createLanguageModelFactory

    if (!isFunction(createFactory)) {
      throw new AppError(
        'VALIDATION',
        'Custom adapter must export createLanguageModelFactory({ config, helpers }).'
      )
    }

    const factory = this.runAdapterFunction<LanguageModelFactory>(
      adapter,
      createFactory,
      [this.createFactoryInput(adapter, config, 'Custom adapter 初始化失败')],
      'Custom adapter 初始化失败'
    )

    if (!isFunction(factory)) {
      throw new AppError(
        'VALIDATION',
        'Custom adapter createLanguageModelFactory must return a function.'
      )
    }

    return (modelId, options) => {
      const safeOptions = this.cloneValueForVm(
        adapter,
        options,
        'Custom adapter model factory 执行失败'
      )
      const descriptor = this.cloneValueFromVm<UserAdapterLanguageModelDescriptor>(
        adapter,
        this.runAdapterFunction(
          adapter,
          factory,
          [modelId, safeOptions],
          'Custom adapter model factory 执行失败'
        ),
        'Custom adapter model factory 执行失败'
      )
      return applyPromptCacheProviderOptions(
        this.createLanguageModelFromDescriptor(
          adapter,
          config,
          descriptor,
          'Custom adapter model factory 执行失败'
        )
      )
    }
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    const adapter = this.evaluateAdapter(config)
    const createEmbeddingRequest =
      adapter.exports.createEmbeddingRequest ?? adapter.exports.default?.createEmbeddingRequest

    if (!isFunction(createEmbeddingRequest)) return super.createEmbeddingRequest(config, model, texts)

    const input = this.createFactoryInput(
      adapter,
      config,
      'Custom adapter embedding 初始化失败'
    ) as UserAdapterFactoryInput & {
      model: string
      texts: string[]
    }
    input.model = model
    input.texts = this.cloneValueForVm(adapter, texts, 'Custom adapter embedding 初始化失败')

    const request = this.cloneValueFromVm<unknown>(
      adapter,
      this.runAdapterFunction(
        adapter,
        createEmbeddingRequest,
        [input],
        'Custom adapter embedding 初始化失败'
      ),
      'Custom adapter embedding 初始化失败'
    )

    return this.normalizeEmbeddingRequest(request, 'Custom adapter embedding 初始化失败')
  }

  private evaluateAdapter(config: ModelAdapterConfig): EvaluatedUserAdapter {
    const source = config.adapter?.source?.trim() ?? ''

    if (isBlank(source)) {
      throw new AppError('VALIDATION', '请先上传 Custom Adapter JS 文件。')
    }

    const cacheKey = this.buildEvaluationCacheKey(config, source)
    const cached = this.evaluatedAdapterCache.get(cacheKey)
    if (cached) return cached

    const context = createUserAdapterVmContext()

    try {
      const script = new Script(`"use strict";\n${source}`, {
        filename: config.adapter?.filename || UserAdapterFilename,
      })
      this.runVmScript(script, context)

      const result = context.module.exports
      const evaluated = {
        context,
        exports: result && isObject(result) ? result : context.module.exports,
        helpers: context.helpers,
      }
      this.rememberEvaluatedAdapter(cacheKey, evaluated)
      return evaluated
    } catch (error) {
      throw new AppError('VALIDATION', `Custom adapter 加载失败：${AppError.getMessage(error)}`)
    }
  }

  private buildEvaluationCacheKey(config: ModelAdapterConfig, source: string): string {
    return [
      config.provider,
      config.adapter?.providerId ?? '',
      config.adapter?.filename || UserAdapterFilename,
      source,
    ].join('\n')
  }

  private rememberEvaluatedAdapter(cacheKey: string, adapter: EvaluatedUserAdapter): void {
    if (this.evaluatedAdapterCache.size >= UserAdapterEvaluationCacheLimit) {
      const oldestKey = this.evaluatedAdapterCache.keys().next().value
      if (isString(oldestKey)) {
        this.evaluatedAdapterCache.delete(oldestKey)
      }
    }

    this.evaluatedAdapterCache.set(cacheKey, adapter)
  }

  private createFactoryInput(
    adapter: EvaluatedUserAdapter,
    config: ModelAdapterConfig,
    errorPrefix: string
  ): UserAdapterFactoryInput {
    const input = Object.create(null) as UserAdapterFactoryInput
    input.config = this.cloneValueForVm(adapter, config, errorPrefix)
    input.helpers = adapter.helpers
    return input
  }

  private cloneValueForVm<T>(adapter: EvaluatedUserAdapter, value: T, errorPrefix: string): T {
    if (isUndefined(value)) return value

    try {
      const serialized = JSON.stringify(value)
      if (isUndefined(serialized)) return undefined as T

      adapter.context.__velarosUserAdapterJson__ = serialized
      return this.runVmScript<T>(UserAdapterJsonCloneScript, adapter.context)
    } catch (error) {
      throw new AppError('VALIDATION', `${errorPrefix}：${AppError.getMessage(error)}`)
    } finally {
      delete adapter.context.__velarosUserAdapterJson__
    }
  }

  private cloneValueFromVm<T>(adapter: EvaluatedUserAdapter, value: unknown, errorPrefix: string): T {
    if (isUndefined(value)) return value as T

    adapter.context.__velarosUserAdapterValue__ = value

    try {
      const serialized = this.runVmScript<string | undefined>(
        UserAdapterJsonStringifyScript,
        adapter.context
      )
      if (isUndefined(serialized)) return undefined as T

      return JSON.parse(serialized) as T
    } catch (error) {
      throw new AppError('VALIDATION', `${errorPrefix}：${AppError.getMessage(error)}`)
    } finally {
      delete adapter.context.__velarosUserAdapterValue__
    }
  }

  private runAdapterFunction<TResult>(
    adapter: EvaluatedUserAdapter,
    fn: UserAdapterVmCallable,
    args: unknown[],
    errorPrefix: string
  ): TResult {
    const script = UserAdapterCallScripts[args.length]
    if (!script) {
      throw new AppError('VALIDATION', `${errorPrefix}：Custom adapter 调用参数过多。`)
    }

    const call = Object.create(null) as UserAdapterVmCall
    call.fn = fn
    call.arg0 = args[0]
    call.arg1 = args[1]
    adapter.context.__velarosUserAdapterCall__ = call

    try {
      this.runVmScript(script, adapter.context)
      return call.result as TResult
    } catch (error) {
      throw new AppError('VALIDATION', `${errorPrefix}：${AppError.getMessage(error)}`)
    } finally {
      delete adapter.context.__velarosUserAdapterCall__
    }
  }

  private createLanguageModelFromDescriptor(
    adapter: EvaluatedUserAdapter,
    config: ModelAdapterConfig,
    descriptor: unknown,
    errorPrefix: string
  ): LanguageModel {
    void adapter
    const normalized = normalizeLanguageModelDescriptor(descriptor, errorPrefix)
    const settings = normalizeProviderSettings(config, normalized.settings)

    switch (normalized.providerKind) {
      case 'openai': {
        const provider = createOpenAI(settings)
        return provider.chat(normalized.modelId)
      }
      case 'anthropic': {
        const provider = createAnthropic(settings)
        return provider(normalized.modelId)
      }
      case 'google': {
        const provider = createGoogleGenerativeAI(settings)
        return provider(normalized.modelId)
      }
    }
  }

  private runVmScript<T = unknown>(script: Script, context: UserAdapterVmContext): T {
    const startedAt = Date.now()
    const result = script.runInContext(context, {
      displayErrors: true,
      timeout: UserAdapterExecutionTimeoutMs,
    }) as T
    const durationMs = Date.now() - startedAt
    if (durationMs > UserAdapterExecutionTimeoutMs) {
      throw new Error(`Script execution timed out after ${durationMs}ms.`)
    }
    return result
  }

  private normalizeEmbeddingRequest(value: unknown, errorPrefix: string): EmbeddingRequest {
    if (!isObject(value)) {
      throw new AppError(
        'VALIDATION',
        `${errorPrefix}：Custom adapter createEmbeddingRequest must return a JSON-safe { url, headers, body } request.`
      )
    }

    const request = value as Record<string, unknown>
    if (!isString(request.url)) {
      throw new AppError(
        'VALIDATION',
        `${errorPrefix}：Custom adapter createEmbeddingRequest must return a JSON-safe { url, headers, body } request.`
      )
    }

    return {
      url: request.url,
      headers: normalizeStringRecord(request.headers, `${errorPrefix}：Embedding headers`),
      body: request.body,
    }
  }
}

function createUserAdapterVmContext(): UserAdapterVmContext {
  const context = createContext(Object.create(null)) as UserAdapterVmContext
  context.console = createSafeConsole()
  UserAdapterContextSetupScript.runInContext(context, {
    displayErrors: true,
    timeout: UserAdapterExecutionTimeoutMs,
  })
  return context
}

function createSafeConsole(): UserAdapterConsole {
  const safeConsole = Object.create(null) as UserAdapterConsole
  safeConsole.debug = createSafeCallable(createUserAdapterConsoleMethod('debug'))
  safeConsole.error = createSafeCallable(createUserAdapterConsoleMethod('error'))
  safeConsole.info = createSafeCallable(createUserAdapterConsoleMethod('info'))
  safeConsole.log = createSafeCallable(createUserAdapterConsoleMethod('log'))
  safeConsole.warn = createSafeCallable(createUserAdapterConsoleMethod('warn'))
  return Object.freeze(safeConsole)
}

function createUserAdapterConsoleMethod(
  method: UserAdapterConsoleMethod
): UserAdapterConsole[UserAdapterConsoleMethod] {
  return ((...args: unknown[]) => {
    const logLevel = UserAdapterConsoleLogLevels[method]
    const message = formatUserAdapterConsoleMessage(method, args)
    UserAdapterConsoleLog[logLevel](message)
  }) as UserAdapterConsole[UserAdapterConsoleMethod]
}

function formatUserAdapterConsoleMessage(
  method: UserAdapterConsoleMethod,
  args: unknown[]
): string {
  const message = args.map(formatUserAdapterConsoleArg).filter((arg) => !isBlank(arg)).join(' ')
  if (isBlank(message)) return `用户 JS adapter console.${method}`

  return `用户 JS adapter console.${method}: ${message}`
}

function formatUserAdapterConsoleArg(value: unknown): string {
  if (isString(value)) return value
  if (value instanceof Error) return value.stack || value.message

  try {
    const serialized = JSON.stringify(value)
    if (isString(serialized)) return serialized
  } catch (error) {
    Log.tag('UserJsModelAdapter').warn('user adapter console arg JSON.stringify failed, using String fallback', { error })
  }

  return String(value)
}

function createSafeCallable<T>(fn: T): T {
  const safeFn = ((...args: unknown[]) =>
    (fn as (...args: unknown[]) => unknown)(...args)) as T
  hardenExposedFunction(safeFn)
  return safeFn
}

function hardenExposedFunction(value: unknown): void {
  if (!isFunction(value)) return

  Object.defineProperty(value, 'constructor', {
    configurable: false,
    enumerable: false,
    value: undefined,
    writable: false,
  })
  Object.setPrototypeOf(value, null)
  Object.freeze(value)
}

function normalizeLanguageModelDescriptor(
  value: unknown,
  errorPrefix: string
): UserAdapterLanguageModelDescriptor {
  const descriptor = isObject(value) ? (value as Record<string, unknown>) : null
  if (
    !descriptor ||
    descriptor.__velarosCustomAdapterDescriptor !== 'language-model' ||
    !isUserAdapterProviderKind(descriptor.providerKind) ||
    !isString(descriptor.modelId) ||
    isBlank(descriptor.modelId)
  ) {
    throw new AppError(
      'VALIDATION',
      `${errorPrefix}：Custom adapter model factory must return helpers.createOpenAI(...).chat(modelId), helpers.createAnthropic(...)(modelId), or helpers.createGoogleGenerativeAI(...)(modelId).`
    )
  }

  return {
    __velarosCustomAdapterDescriptor: 'language-model',
    providerKind: descriptor.providerKind,
    modelId: descriptor.modelId,
    settings: isObject(descriptor.settings)
      ? normalizeStringRecord(descriptor.settings, errorPrefix)
      : {},
  }
}

function normalizeProviderSettings(
  config: ModelAdapterConfig,
  settings: UserAdapterProviderSettings | undefined
): UserAdapterProviderSettings {
  return {
    apiKey: settings?.apiKey ?? config.apiKey,
    baseURL: settings?.baseURL ?? config.baseURL,
    name: settings?.name ?? config.adapter?.providerId ?? config.provider,
  }
}

function normalizeStringRecord(value: unknown, errorPrefix: string): Record<string, string> {
  if (!isPresent(value)) return {}
  if (!isObject(value)) {
    throw new AppError('VALIDATION', `${errorPrefix} must be an object with string values.`)
  }

  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isString(item)) {
      throw new AppError('VALIDATION', `${errorPrefix} contains a non-string value for ${key}.`)
    }
    output[key] = item
  }
  return output
}

function isUserAdapterProviderKind(value: unknown): value is UserAdapterProviderKind {
  return value === 'openai' || value === 'anthropic' || value === 'google'
}

export { UserJsModelAdapter }
