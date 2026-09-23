import { createContext, type Script } from 'node:vm'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

import {
  isBlank,
  isFunction,
  isPlainObject,
  isPresent,
  isString,
  isUndefined,
  Log,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { ModelErrorCodes } from '../../contract/constants.js'
import type { EmbeddingRequest, ModelAdapterConfig } from '../../types/adapters'
import type {
  EvaluatedUserAdapter,
  UserAdapterConsole,
  UserAdapterConsoleLogLevel,
  UserAdapterConsoleMethod,
  UserAdapterFactoryInput,
  UserAdapterLanguageModelDescriptor,
  UserAdapterProviderKind,
  UserAdapterProviderSettings,
  UserAdapterVmCall,
  UserAdapterVmCallable,
  UserAdapterVmContext,
} from '../../types/user-adapter'
import { ModelTuning } from '../tuning'

/** 沙箱脚本在栈里显示的文件名。 */
export const UserAdapterFilename = 'velaros-custom-model-adapter.js'

/** 沙箱 console 各方法落到宿主日志的级别。 */
const UserAdapterConsoleLogLevels = {
  debug: 'debug',
  error: 'error',
  info: 'info',
  log: 'info',
  warn: 'warn',
} satisfies Record<UserAdapterConsoleMethod, UserAdapterConsoleLogLevel>

const UserAdapterConsoleLog = logRuntime.tag('UserJsModelAdapter.console')

/**
 * 沙箱 realm 的初始化源码：建空原型的 module/exports，装三个只会返回描述符的 provider 工厂。
 *
 * `hardenFunction` 是隔离的第二层：不把暴露进去的函数的 `constructor` 置空并断原型链，
 * 脚本可以走 `helpers.createOpenAI.constructor('return process')()` 拿回宿主 realm。
 */
export const UserAdapterContextSetupSource = `
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
`

/** 跨边界调用沙箱函数的源码，按实参个数各一份；调用在沙箱 realm 里发生。 */
export const UserAdapterCallSources = [
  `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  call.result = call.fn()
})()
`,
  `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  call.result = call.fn(call.arg0)
})()
`,
  `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  call.result = call.fn(call.arg0, call.arg1)
})()
`,
]

/** 在沙箱 realm 里 parse 一段 JSON，把宿主的值搬进去。 */
export const UserAdapterJsonCloneSource = `
"use strict";
JSON.parse(globalThis.__velarosUserAdapterJson__)
`

/** 在沙箱 realm 里 stringify 一个值，把沙箱的值搬出来。 */
export const UserAdapterJsonStringifySource = `
"use strict";
JSON.stringify(globalThis.__velarosUserAdapterValue__)
`

/** 跑一段沙箱脚本；V8 的 timeout 只打断同步执行，所以事后再复核一次实际时长。 */
export function runUserAdapterScript<T = unknown>(
  script: Script,
  context: UserAdapterVmContext
): T {
  const startedAt = Date.now()
  const result = script.runInContext(context, {
    displayErrors: true,
    timeout: ModelTuning.userAdapter.executionTimeoutMs,
  }) as T
  const durationMs = Date.now() - startedAt
  // V8 的 timeout 只打断同步执行；这道事后复核兜住"墙没生效"的情形，超时一律当失败（§0.1 条三）。
  if (durationMs > ModelTuning.userAdapter.executionTimeoutMs) {
    throw new AppError(
      'TIMEOUT',
      `Custom adapter 脚本执行超时（${durationMs}ms > ${ModelTuning.userAdapter.executionTimeoutMs}ms）。`
    )
  }
  return result
}

/** 建一个空原型的沙箱上下文，并跑一遍初始化脚本。 */
export function createUserAdapterVmContext(setupScript: Script): UserAdapterVmContext {
  const context = createContext(Object.create(null)) as UserAdapterVmContext
  context.console = createSafeConsole()
  runUserAdapterScript(setupScript, context)
  return context
}

/** 把宿主的值经 JSON 搬进沙箱：只传可序列化的值，不把宿主原型链递过去。 */
export function cloneValueForVm<T>(
  adapter: EvaluatedUserAdapter,
  value: T,
  errorPrefix: string,
  cloneScript: Script
): T {
  if (isUndefined(value)) return value

  try {
    const serialized = JSON.stringify(value)
    if (isUndefined(serialized)) return undefined as T

    adapter.context.__velarosUserAdapterJson__ = serialized
    return runUserAdapterScript<T>(cloneScript, adapter.context)
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：${AppError.getMessage(error)}`
    )
  } finally {
    delete adapter.context.__velarosUserAdapterJson__
  }
}

/** 把沙箱的值经 JSON 搬回宿主，方向与 {@link cloneValueForVm} 相反。 */
export function cloneValueFromVm<T>(
  adapter: EvaluatedUserAdapter,
  value: unknown,
  errorPrefix: string,
  stringifyScript: Script
): T {
  if (isUndefined(value)) return value as T

  adapter.context.__velarosUserAdapterValue__ = value

  try {
    const serialized = runUserAdapterScript<string | undefined>(stringifyScript, adapter.context)
    if (isUndefined(serialized)) return undefined as T

    return JSON.parse(serialized) as T
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：${AppError.getMessage(error)}`
    )
  } finally {
    delete adapter.context.__velarosUserAdapterValue__
  }
}

/** 在沙箱 realm 里调用户 adapter 导出的函数，最多两个实参。 */
export function callUserAdapterFunction<TResult>(
  adapter: EvaluatedUserAdapter,
  fn: UserAdapterVmCallable,
  args: unknown[],
  errorPrefix: string,
  callScripts: readonly Script[]
): TResult {
  const script = callScripts[args.length]
  if (!script) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：Custom adapter 调用参数过多。`
    )
  }

  const call = Object.create(null) as UserAdapterVmCall
  call.fn = fn
  call.arg0 = args[0]
  call.arg1 = args[1]
  adapter.context.__velarosUserAdapterCall__ = call

  try {
    runUserAdapterScript(script, adapter.context)
    return call.result as TResult
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：${AppError.getMessage(error)}`
    )
  } finally {
    delete adapter.context.__velarosUserAdapterCall__
  }
}

/** 拼一次导出函数调用的入参：config 搬进沙箱，helpers 是沙箱自己的那份。 */
export function createUserAdapterFactoryInput(
  adapter: EvaluatedUserAdapter,
  config: ModelAdapterConfig,
  errorPrefix: string,
  cloneScript: Script
): UserAdapterFactoryInput {
  const input = Object.create(null) as UserAdapterFactoryInput
  input.config = cloneValueForVm(adapter, config, errorPrefix, cloneScript)
  input.helpers = adapter.helpers
  return input
}

/** 已求值 adapter 的缓存键：provider、adapter 身份与源码逐字参与，源码一改就重新求值。 */
export function buildUserAdapterCacheKey(config: ModelAdapterConfig, source: string): string {
  return [
    config.provider,
    config.adapter?.providerId ?? '',
    config.adapter?.filename || UserAdapterFilename,
    source,
  ].join('\n')
}

/** 沙箱返回的描述符校验：三元组缺一不可，别放宽它，放宽等于让脚本自己造 SDK 实例。 */
export function normalizeLanguageModelDescriptor(
  value: unknown,
  errorPrefix: string
): UserAdapterLanguageModelDescriptor {
  const descriptor = isPlainObject(value) ? value : null
  if (
    !descriptor ||
    descriptor.__velarosCustomAdapterDescriptor !== 'language-model' ||
    !isUserAdapterProviderKind(descriptor.providerKind) ||
    !isString(descriptor.modelId) ||
    isBlank(descriptor.modelId)
  ) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：Custom adapter 的模型工厂必须返回 helpers.createOpenAI(...).chat(模型名)、helpers.createAnthropic(...)(模型名) 或 helpers.createGoogleGenerativeAI(...)(模型名)。`
    )
  }

  return {
    __velarosCustomAdapterDescriptor: 'language-model',
    providerKind: descriptor.providerKind,
    modelId: descriptor.modelId,
    settings: isPlainObject(descriptor.settings)
      ? normalizeStringRecord(descriptor.settings, errorPrefix)
      : {},
  }
}

/** 在宿主侧按描述符造真正的 SDK 语言模型；脚本永远碰不到真实 fetch 与 apiKey 载体。 */
export function createLanguageModelFromDescriptor(
  config: ModelAdapterConfig,
  descriptor: UserAdapterLanguageModelDescriptor
): LanguageModel {
  const settings = normalizeProviderSettings(config, descriptor.settings)

  switch (descriptor.providerKind) {
    case 'openai': {
      const provider = createOpenAI(settings)
      return provider.chat(descriptor.modelId)
    }
    case 'anthropic': {
      const provider = createAnthropic(settings)
      return provider(descriptor.modelId)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI(settings)
      return provider(descriptor.modelId)
    }
  }
}

/** 沙箱返回的 embedding 请求：必须是 JSON 安全的 `{ url, headers, body }`。 */
export function normalizeUserAdapterEmbeddingRequest(
  value: unknown,
  errorPrefix: string
): EmbeddingRequest {
  if (!isPlainObject(value) || !isString(value.url)) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：Custom adapter 的 createEmbeddingRequest 必须返回 JSON 安全的 { url, headers, body }。`
    )
  }

  return {
    url: value.url,
    headers: normalizeStringRecord(value.headers, `${errorPrefix}：Embedding 请求头`),
    body: value.body,
  }
}

/** 建沙箱能用的 console：只有五个方法，全部转写进宿主日志。 */
function createSafeConsole(): UserAdapterConsole {
  const safeConsole = Object.create(null) as UserAdapterConsole
  safeConsole.debug = createSafeCallable(createUserAdapterConsoleMethod('debug'))
  safeConsole.error = createSafeCallable(createUserAdapterConsoleMethod('error'))
  safeConsole.info = createSafeCallable(createUserAdapterConsoleMethod('info'))
  safeConsole.log = createSafeCallable(createUserAdapterConsoleMethod('log'))
  safeConsole.warn = createSafeCallable(createUserAdapterConsoleMethod('warn'))
  return Object.freeze(safeConsole)
}

/** 造一个把沙箱 console 调用转写进宿主日志的函数。 */
function createUserAdapterConsoleMethod(
  method: UserAdapterConsoleMethod
): UserAdapterConsole[UserAdapterConsoleMethod] {
  return ((...args: unknown[]) => {
    const logLevel = UserAdapterConsoleLogLevels[method]
    const message = formatUserAdapterConsoleMessage(method, args)
    UserAdapterConsoleLog[logLevel](message)
  }) as UserAdapterConsole[UserAdapterConsoleMethod]
}

/** 把沙箱 console 的实参拼成一行日志文字。 */
function formatUserAdapterConsoleMessage(
  method: UserAdapterConsoleMethod,
  args: unknown[]
): string {
  const message = args
    .map(formatUserAdapterConsoleArg)
    .filter((arg) => !isBlank(arg))
    .join(' ')
  if (isBlank(message)) return `用户 JS adapter console.${method}`

  return `用户 JS adapter console.${method}: ${message}`
}

/** 单个 console 实参转成字符串；序列化不了就退回 String()。 */
function formatUserAdapterConsoleArg(value: unknown): string {
  if (isString(value)) return value
  if (value instanceof Error) return value.stack || value.message

  try {
    const serialized = JSON.stringify(value)
    if (isString(serialized)) return serialized
  } catch (error) {
    Log.tag('UserJsModelAdapter').warn(
      '用户 adapter console 实参 JSON.stringify 失败，改用 String 兜底',
      { error }
    )
  }

  return String(value)
}

/** 包一层再硬化：暴露进沙箱的函数不能让脚本经 `constructor` 走回宿主 realm。 */
function createSafeCallable<T>(fn: T): T {
  const safeFn = ((...args: unknown[]) => (fn as (...args: unknown[]) => unknown)(...args)) as T
  hardenExposedFunction(safeFn)
  return safeFn
}

/** 把一个函数的 `constructor` 置空、断原型链并冻结。 */
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

/** provider 设置：脚本没给的字段回落到这次请求的 config。 */
function normalizeProviderSettings(
  config: ModelAdapterConfig,
  settings: Optional<UserAdapterProviderSettings>
): UserAdapterProviderSettings {
  return {
    apiKey: settings?.apiKey ?? config.apiKey,
    baseURL: settings?.baseURL ?? config.baseURL,
    name: settings?.name ?? config.adapter?.providerId ?? config.provider,
  }
}

/** 收一张只许是字符串值的表；有一个不是字符串就整体拒。 */
function normalizeStringRecord(value: unknown, errorPrefix: string): Record<string, string> {
  if (!isPresent(value)) return {}
  if (!isPlainObject(value)) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}必须是一个值全为字符串的对象。`
    )
  }

  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isString(item)) {
      throw new AppError(
        ModelErrorCodes.customAdapterInvalid,
        `${errorPrefix}的 ${key} 不是字符串。`
      )
    }
    output[key] = item
  }
  return output
}

/** 描述符里的 provider 种类是不是本包认的那三种。 */
function isUserAdapterProviderKind(value: unknown): value is UserAdapterProviderKind {
  return value === 'openai' || value === 'anthropic' || value === 'google'
}
