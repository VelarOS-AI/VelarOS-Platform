import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  isArray,
  isBlank,
  isBoolean,
  isEmpty,
  isFalse,
  isFunction,
  isPlainObject,
  isPresent,
  isString,
  optionalWhen,
  toOptional,
  trimmedStringOrEmpty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes, ModelProviderOperationalManifests } from '../../contract/constants.js'
import type {
  ProviderScriptDefinition,
  ProviderScriptHelpers,
} from '../../contract/requires'
import type {
  ChatProviderId,
  ModelInputModality,
  ModelRequestOptions,
  ProviderModelCatalogEntry,
  ProviderScriptManifest,
  ProviderScriptRuntimeMetadata,
} from '../../types/model'
import type { ProviderScriptDevConfig } from '../../types/scripts'
import { toPositiveInteger } from '../numbers'

/** 内置 provider 的 id；注入的 provider 不许跟它们撞名。 */
const BuiltInProviderIds = new Set<string>(
  ModelProviderOperationalManifests.map((manifest) => manifest.id)
)

/** provider script 定义里除 manifest 外的成员，存在时必须是函数。 */
const ProviderScriptDefinitionOptionalMembers = [
  'createLanguageModelFactory',
  'createEmbeddingRequest',
  'validate',
  'listModels',
  'resolveRuntimeMetadata',
] as const

/** 注入 provider id 的形状规则：小写开头、只许小写字母数字与 `._-`，且不与内置 id 冲突。 */
export function normalizeInjectedProviderId(value: unknown): Nullable<ChatProviderId> {
  const providerId = trimmedStringOrEmpty(value)
  if (!/^[a-z][a-z0-9._-]{1,63}$/u.test(providerId)) return null
  if (BuiltInProviderIds.has(providerId)) return null

  return providerId as ChatProviderId
}

/** 把脚本给的模型清单归一成目录条目；id 空白的整条丢掉。 */
export function normalizeProviderScriptModels(value: unknown): ProviderModelCatalogEntry[] {
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

/** 把脚本给的运行时元数据归一；不是对象就当没给。 */
export function normalizeRuntimeMetadata(value: unknown): Nullable<ProviderScriptRuntimeMetadata> {
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

/** 只收 text/image/audio 三种输入形态并去重；一个都不剩时按未知处理。 */
export function normalizeModelInputModalities(value: unknown): ModelInputModality[] | undefined {
  if (!isArray(value)) return undefined

  const modalities = [...new Set(value.filter(
    (entry): entry is ModelInputModality =>
      entry === 'text' || entry === 'image' || entry === 'audio'
  ))]
  return !isEmpty(modalities) ? modalities : undefined
}

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

/** 形状不对就按 providerScriptInvalid 抛，带上调用方给的中文说明。 */
export function parseProviderScriptDefinition(
  value: unknown,
  message: string
): ProviderScriptDefinition {
  if (!isProviderScriptDefinitionShape(value)) {
    throw new AppError(ModelErrorCodes.providerScriptInvalid, message)
  }
  return value
}

/** 空白字符串按缺席处理。 */
function optionalTrimmedString(value: unknown): string | undefined {
  const normalized = trimmedStringOrEmpty(value)
  return normalized || undefined
}

/** 归一并校验 provider script 的 manifest；缺必填项或 id 冲突一律拒。 */
export function normalizeProviderScriptManifest(value: unknown): ProviderScriptManifest {
  if (!isPlainObject(value)) {
    throw new AppError(ModelErrorCodes.providerScriptInvalid, 'provider script 缺少 manifest。')
  }

  const id = normalizeInjectedProviderId(value.id)
  if (!id) {
    throw new AppError(
      ModelErrorCodes.providerScriptInvalid,
      'provider script manifest.id 无效或与内置 provider 冲突。'
    )
  }

  const label = trimmedStringOrEmpty(value.label)
  const description = trimmedStringOrEmpty(value.description)
  const defaultModel = trimmedStringOrEmpty(value.defaultModel)
  const models = normalizeProviderScriptModels(value.models)
  if (!label || !description || !defaultModel || isEmpty(models)) {
    throw new AppError(
      ModelErrorCodes.providerScriptInvalid,
      'provider script manifest 必须声明 label、description、defaultModel 和 models。'
    )
  }
  if (!models.some((model) => model.id === defaultModel)) {
    throw new AppError(
      ModelErrorCodes.providerScriptInvalid,
      'provider script manifest.defaultModel 必须存在于 models。'
    )
  }

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

/** 从 dev.json 里读出启用着的脚本路径；整段关掉或形状不对时返回空表。 */
export function readEnabledScriptEntries(config: ProviderScriptDevConfig): string[] {
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

/** 读一份 dev.json；读不动或不是 JSON 一律按 providerScriptInvalid 抛，不静默跳过。 */
export function readProviderScriptDevConfig(configPath: string): ProviderScriptDevConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    return isPlainObject(parsed) ? (parsed as ProviderScriptDevConfig) : {}
  } catch (error) {
    throw new AppError(
      ModelErrorCodes.providerScriptInvalid,
      `读取 provider script 配置失败：${configPath}: ${AppError.getMessage(error)}`
    )
  }
}

/** 把脚本的导出面归一成受信定义：工厂形、`createProviderScript` 形与普通对象形都收。 */
export function normalizeLoadedDefinition(
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
    throw new AppError(ModelErrorCodes.providerScriptInvalid, 'provider script 必须导出对象。')
  }

  const factory = (candidate as { createProviderScript?: unknown }).createProviderScript
  if (isFunction(factory)) return parseProviderScriptDefinition(
      factory({ helpers }),
      'createProviderScript 必须返回合法定义对象。'
    )

  return parseProviderScriptDefinition(candidate, 'provider script 必须导出合法定义对象。')
}

/** 开发者本机 dev.json 的候选路径：先看工作目录，再看用户目录。 */
export function providerScriptDevConfigCandidates(cwd: string, homeDir: string): string[] {
  return [join(cwd, '.velaros/dev.json'), join(homeDir, '.velaros/dev.json')]
}
