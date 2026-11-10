import { isNativeError } from 'node:util/types'
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
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { ModelErrorCodes } from '../../contract/constants.js'
import type { EmbeddingRequest, ModelAdapterConfig } from '../../types/adapters'
import type {
  EvaluatedUserAdapter,
  UserAdapterConsoleLogLevel,
  UserAdapterConsoleMethod,
  UserAdapterExports,
  UserAdapterFactoryInput,
  UserAdapterHelpers,
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
  const formatConsoleArg = (value) => {
    if (typeof value === "string") return value
    if (value instanceof Error) return value.stack || value.message
    try {
      const serialized = JSON.stringify(value)
      if (typeof serialized === "string") return serialized
    } catch {}
    return String(value)
  }
  const safeConsole = Object.create(null)
  for (const method of ["debug", "error", "info", "log", "warn"]) {
    safeConsole[method] = hardenFunction((...args) => {
      const message = args.map(formatConsoleArg).filter(arg => arg.trim()).join(" ")
      const delivered = globalThis.__velarosUserAdapterLog__(method, message
        ? "用户 JS adapter console." + method + ": " + message
        : "用户 JS adapter console." + method)
      if (delivered !== true) throw new Error("Custom adapter console 日志写入失败")
    })
  }
  globalThis.console = Object.freeze(safeConsole)
})()
`

/** 只处理同一 VM 操作内捕获的抛值；原值不经过宿主再送回 VM。 */
const UserAdapterErrorMessageSource = `
(error) => {
  const read = (value, depth = 0) => {
    if (depth > 5 || value == null) return ""
    if (typeof value === "string") return value.trim()
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (typeof value !== "object" && typeof value !== "function") return ""
    const message = value.message
    if (typeof message === "string" && message.trim()) return message.trim()
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = read(item, depth + 1)
        if (nested) return nested
      }
    }
    for (const key of ["error", "cause", "lastError", "errors"]) {
      const nested = read(value[key], depth + 1)
      if (nested) return nested
    }
    return ""
  }
  try {
    const message = read(error)
    return typeof message === "string" && message ? message : "Custom adapter 执行失败"
  } catch {
    return "Custom adapter 错误详情无法在执行预算内读取"
  }
}
`

/** 本单元的受控操作在原执行墙内捕获抛值，只通过固定数据槽交出原始字符串。 */
function guardedUserAdapterSource(body: string): string {
  return `
"use strict";
(() => {
  const call = globalThis.__velarosUserAdapterCall__
  try {
    ${body}
  } catch (error) {
    call.failed = true
    call.result = undefined
    call.error = (${UserAdapterErrorMessageSource})(error)
  }
})()
`
}

/** 导出与 helpers 的快照引用在墙内读取；getter 与 Proxy 仍按普通 JS 语义执行。 */
export const UserAdapterCaptureSource = guardedUserAdapterSource(`
  call.result = globalThis.module.exports
  call.arg0 = globalThis.helpers
`)

/** named 优先于 default 的导出选择也在墙内，不把属性读取留给宿主。 */
export const UserAdapterExportSource = guardedUserAdapterSource(`
  call.result = call.arg0[call.arg1] ?? call.arg0.default?.[call.arg1]
`)

/** 跨边界调用沙箱函数的源码，按实参个数各一份；调用在沙箱 realm 里发生。 */
export const UserAdapterCallSources = [
  guardedUserAdapterSource('call.result = call.fn()'),
  guardedUserAdapterSource('call.result = call.fn(call.arg0)'),
  guardedUserAdapterSource('call.result = call.fn(call.arg0, call.arg1)'),
]

/** 在沙箱 realm 里 parse 一段 JSON，把宿主的值搬进去。 */
export const UserAdapterJsonCloneSource = guardedUserAdapterSource(
  'call.result = JSON.parse(globalThis.__velarosUserAdapterJson__)'
)

/** 在沙箱 realm 里 stringify 一个值，把沙箱的值搬出来。 */
export const UserAdapterJsonStringifySource = guardedUserAdapterSource(
  'call.result = JSON.stringify(globalThis.__velarosUserAdapterValue__)'
)

/** 跑一段同步合同的沙箱脚本；上下文会在返回前排空微任务，执行与 Promise jobs 共用期限。 */
export function runUserAdapterScript<T = unknown>(
  script: Script,
  context: UserAdapterVmContext
): T {
  const startedAt = Date.now()
  const result = script.runInContext(context, {
    displayErrors: false,
    timeout: ModelTuning.userAdapter.executionTimeoutMs,
  }) as T
  const durationMs = Date.now() - startedAt
  // 上下文的 afterEvaluate 把 Promise jobs 纳入执行墙；事后仍复核实际时长，超时一律当失败。
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
  const context = createContext(Object.create(null), {
    microtaskMode: 'afterEvaluate',
  }) as UserAdapterVmContext
  for (const key of [
    '__velarosUserAdapterCall__',
    '__velarosUserAdapterJson__',
    '__velarosUserAdapterValue__',
  ])
    Object.defineProperty(context, key, { value: undefined, writable: true })
  Object.defineProperty(context, '__velarosUserAdapterLog__', {
    value: createSafeCallable(writePrimitiveConsoleMessage),
  })
  runUserAdapterScript(setupScript, context)
  return context
}

/** 首次求值结束时在墙内捕获引用；宿主只读自己载荷上不可重定义的数据槽。 */
export function captureUserAdapter(
  context: UserAdapterVmContext,
  captureScript: Script
): EvaluatedUserAdapter {
  const call = createUserAdapterVmCall()
  const exports = runUserAdapterCall<UserAdapterExports>(
    context,
    call,
    captureScript,
    'Custom adapter 导出捕获失败'
  )
  return {
    context,
    exports,
    helpers: call.arg0 as UserAdapterHelpers,
  }
}

/** 取一个导出 hook，属性访问、default 回退与 Proxy trap 都在有界脚本内。 */
export function readUserAdapterExport(
  adapter: EvaluatedUserAdapter,
  name: 'createLanguageModelFactory' | 'createEmbeddingRequest',
  errorPrefix: string,
  exportScript: Script
): unknown {
  return runUserAdapterCall(
    adapter.context,
    createUserAdapterVmCall(undefined, [adapter.exports, name]),
    exportScript,
    errorPrefix
  )
}

/** 越墙异常只取原生 Error 自身的数据 message；不执行 getter、Proxy 或对象转换，也不回流 VM。 */
export function readUserAdapterErrorMessage(error: unknown): string {
  const fallback = 'Custom adapter 错误详情无法在执行预算内读取'
  if (isString(error)) return error
  if (isNativeError(error)) {
    const message = Object.getOwnPropertyDescriptor(error, 'message')?.value
    if (isString(message)) return message
  }
  return fallback
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

    setUserAdapterSlot(adapter.context, '__velarosUserAdapterJson__', serialized)
    return runUserAdapterCall<T>(
      adapter.context,
      createUserAdapterVmCall(),
      cloneScript,
      errorPrefix
    )
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：${readUserAdapterErrorMessage(error)}`
    )
  } finally {
    clearUserAdapterSlot(adapter.context, '__velarosUserAdapterJson__')
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

  try {
    setUserAdapterSlot(adapter.context, '__velarosUserAdapterValue__', value)
    const serialized = runUserAdapterCall<string | undefined>(
      adapter.context,
      createUserAdapterVmCall(),
      stringifyScript,
      errorPrefix
    )
    if (isUndefined(serialized)) return undefined as T
    if (!isString(serialized))
      throw new AppError(
        ModelErrorCodes.customAdapterInvalid,
        'Custom adapter 必须返回 JSON 字符串'
      )

    return JSON.parse(serialized) as T
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：${readUserAdapterErrorMessage(error)}`
    )
  } finally {
    clearUserAdapterSlot(adapter.context, '__velarosUserAdapterValue__')
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

  return runUserAdapterCall<TResult>(
    adapter.context,
    createUserAdapterVmCall(fn, args),
    script,
    errorPrefix
  )
}

/** 调用载荷的数据槽不能变成 getter；receiver 仍是原先的 call 对象。 */
function createUserAdapterVmCall(
  fn?: UserAdapterVmCallable,
  args: readonly unknown[] = []
): UserAdapterVmCall {
  return Object.defineProperties(Object.create(null), {
    fn: { value: fn, writable: true },
    arg0: { value: args[0], writable: true },
    arg1: { value: args[1], writable: true },
    result: { value: undefined, writable: true },
    failed: { value: false, writable: true },
    error: { value: undefined, writable: true },
  }) as UserAdapterVmCall
}

/** 载荷上的结果是宿主自身的数据槽；墙内读到的任何抛值先在墙内提取诊断。 */
function runUserAdapterCall<TResult>(
  context: UserAdapterVmContext,
  call: UserAdapterVmCall,
  script: Script,
  errorPrefix: string
): TResult {
  try {
    setUserAdapterSlot(context, '__velarosUserAdapterCall__', call)
    runUserAdapterScript(script, context)
    if (call.failed)
      throw new AppError(
        ModelErrorCodes.customAdapterInvalid,
        isString(call.error) ? call.error : 'Custom adapter 错误详情无法在执行预算内读取'
      )
    return call.result as TResult
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.customAdapterInvalid,
      `${errorPrefix}：${readUserAdapterErrorMessage(error)}`
    )
  } finally {
    clearUserAdapterSlot(context, '__velarosUserAdapterCall__')
  }
}

/** 内部 global 槽预先固定为数据属性，宿主写值不会触发用户 setter。 */
function setUserAdapterSlot(context: UserAdapterVmContext, key: string, value: unknown): void {
  if (!Reflect.set(context, key, value))
    throw new AppError(ModelErrorCodes.customAdapterInvalid, 'Custom adapter 内部数据槽不可写')
}

/** 清空数据槽而不删除 descriptor；被脚本锁成只读时，后续写入会明确失败。 */
function clearUserAdapterSlot(context: UserAdapterVmContext, key: string): void {
  Reflect.set(context, key, undefined)
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

/** console 实参已在 VM 墙内格式化；宿主只接原始字符串，不检查或转换 VM 对象。 */
function writePrimitiveConsoleMessage(method: unknown, message: unknown): boolean {
  if (
    !isString(message) ||
    (method !== 'debug' &&
      method !== 'error' &&
      method !== 'info' &&
      method !== 'log' &&
      method !== 'warn')
  )
    return false
  try {
    UserAdapterConsoleLog[UserAdapterConsoleLogLevels[method]](message)
    return true
  } catch {
    // arch-guard:silent-catch-ok 日志原错不能跨入 VM；失败回执由 VM console 转为本 realm 的错误。
    return false
  }
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
