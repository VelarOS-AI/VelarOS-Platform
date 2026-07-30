import { isArray, isBoolean, isNonBlankString, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { AgentModelResolver } from './AgentModelResolver'
import type { LanguageModelFactory } from './ModelAdapter'
import type { ModelAdapterRegistryPort } from './ModelAdapterRegistryPort'
import type {
  AgentProviderAdapterConfig,
  AgentProviderRuntimeConfig,
  ChatProviderId,
  ModelProviderSelection,
  ModelRuntimeContext,
  ModelSelection,
  ProviderScriptManifest,
  ReasoningLevel,
  ThinkingDepth,
} from './ModelContracts'

type AgentProvider = LanguageModelFactory

const AgentModelRuntimeLog = logRuntime.tag('AgentModelRuntime')

/**
 * 导览（§5.3b ⑤跨层接缝）——Agent 侧唯一的模型入口。
 *
 * **问题**：Agent 与 Core 不该知道 provider 长什么样，但它们必须能发起一次模型调用。
 * 本类的两个方法各收一个 `unknown`，在这里一次性解析成 Model 域的具体契约；
 * 解析之后（§1.8）包内不再复检。所以**新增 selection 轴必须在本文件加解析分支**，
 * 只改 `ModelContracts.ts` 的类型不会让新字段真的过河。
 *
 * **方向铁律**：解析只做收窄与拒绝，不做业务回退——provider 不可用由
 * `AgentModelResolver` 判并给可读诊断（§2.7），这里抛的一律是 `VALIDATION` 形状错。
 * 唯一的例外是 `providerScript`（见 `parseProviderScriptManifest` 的判据注释）。
 */
class AgentModelRuntime {
  constructor(
    private readonly modelAdapterRegistry: ModelAdapterRegistryPort,
    private readonly modelResolver: AgentModelResolver
  ) {}

  public createAgentProvider(selection: unknown): AgentProvider {
    const config = parseProviderSelection(selection)
    return this.modelAdapterRegistry.createLanguageModelFactory(config)
  }

  public async resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown
  ) {
    return this.modelResolver.resolve(
      parseModelSelection(selection),
      parseModelRuntimeContext(runtimeContext)
    )
  }
}

function parseProviderSelection(value: unknown): ModelProviderSelection {
  const record = requireRecord(value, '模型 selection 必须是对象。')
  const provider = requireNonBlankString(record.provider, '模型 selection.provider 必须显式提供。')

  return {
    provider: provider as ChatProviderId,
    apiKey: optionalString(record.apiKey),
    baseURL: optionalString(record.baseURL),
    adapter: parseAdapter(record.adapter),
    thinkingDepth: parseThinkingDepth(record.thinkingDepth),
    reasoningLevel: parseReasoningLevel(record.reasoningLevel),
  }
}

function parseModelSelection(value: unknown): ModelSelection {
  const record = requireRecord(value, '模型 selection 必须是对象。')
  return {
    ...parseProviderSelection(record),
    model: requireNonBlankString(record.model, '模型 selection.model 必须显式提供。'),
  }
}

function parseModelRuntimeContext(value: unknown): ModelRuntimeContext {
  const record = requireRecord(value, 'Model Runtime context 必须显式提供。')
  if (!Array.isArray(record.providerRuntimeConfigs)) {
    throw new AppError(
      'VALIDATION',
      'Model Runtime context.providerRuntimeConfigs 必须是数组。'
    )
  }
  const openRouter = requireRecord(
    record.openRouter,
    'Model Runtime context.openRouter 必须显式提供。'
  )
  if (typeof openRouter.useFreeModelsForDebug !== 'boolean') {
    throw new AppError(
      'VALIDATION',
      'Model Runtime context.openRouter.useFreeModelsForDebug 必须是布尔值。'
    )
  }

  return {
    providerRuntimeConfigs: record.providerRuntimeConfigs.map(parseRuntimeConfig),
    openRouter: {
      useFreeModelsForDebug: openRouter.useFreeModelsForDebug,
    },
  }
}

function parseRuntimeConfig(value: unknown): AgentProviderRuntimeConfig {
  const record = requireRecord(value, 'providerRuntimeConfigs 成员必须是对象。')
  const provider = requireNonBlankString(
    record.provider,
    'providerRuntimeConfigs.provider 必须显式提供。'
  )
  if (typeof record.enabled !== 'boolean') {
    throw new AppError('VALIDATION', `${provider}.enabled 必须是布尔值。`)
  }

  return {
    provider: provider as ChatProviderId,
    enabled: record.enabled,
    apiKey: optionalString(record.apiKey),
    baseURL: optionalString(record.baseURL),
    defaultModel: optionalString(record.defaultModel),
    adapter: parseAdapter(record.adapter),
    providerScript: parseProviderScriptManifest(record.providerScript, provider),
  }
}

/**
 * 判据（§2.4 失败方向）——这一个字段刻意**不抛**，与同文件其它字段相反。
 *
 * 宿主传来的 manifest 只是随 runtime config 捎带的副本；真正被消费的那份由
 * `ProviderScriptRegistry` 自己 normalize 后经 `requireOperationalManifest` 取（见
 * `ModelProviderCollection.createScriptOperationalManifest`）。在**每一轮模型解析**都会跑的
 * 解析路径上，为一个没人读的副本抛错等于把坏配置升级成"整个会话不能用"——最坏失败模式不可接受。
 * 所以形状不符时降级成缺席并记一条账（§2.6），不静默、也不整体消失。
 *
 * 守卫只校验类型承诺的必备标量与 `models` 数组：函数字段本就不存在，深校验 models 成员
 * 属 registry 的活（单源在 `normalizeProviderScriptManifest`），这里复检会造出第二份口径（§1.8）。
 */
function parseProviderScriptManifest(
  value: unknown,
  provider: string
): ProviderScriptManifest | undefined {
  if (!isPresent(value)) return undefined
  if (isProviderScriptManifestShape(value)) return value

  AgentModelRuntimeLog.warn('providerScript manifest 形状不符，已按缺席处理', { provider })
  return undefined
}

function isProviderScriptManifestShape(value: unknown): value is ProviderScriptManifest {
  if (!isPlainObject(value)) return false

  return (
    isString(value.id)
    && isString(value.label)
    && isString(value.description)
    && isString(value.defaultBaseURL)
    && isString(value.defaultApiKey)
    && isString(value.defaultModel)
    && isBoolean(value.apiKeyOptional)
    && isBoolean(value.baseURLConfigurable)
    && isBoolean(value.enabledByDefault)
    && isArray(value.models)
  )
}

function parseAdapter(value: unknown): AgentProviderAdapterConfig | undefined {
  if (!isPresent(value)) return undefined
  const record = requireRecord(value, '模型 adapter 必须是对象。')
  if (record.kind !== 'js') {
    throw new AppError('VALIDATION', '模型 adapter.kind 必须是 js。')
  }

  return {
    kind: 'js',
    providerId: requireNonBlankString(record.providerId, 'adapter.providerId 必须显式提供。'),
    filename: requireNonBlankString(record.filename, 'adapter.filename 必须显式提供。'),
    source: requireNonBlankString(record.source, 'adapter.source 必须显式提供。'),
  }
}

function parseThinkingDepth(value: unknown): ThinkingDepth | undefined {
  if (!isPresent(value)) return undefined
  if (value === 'fast' || value === 'balanced' || value === 'deep') return value
  throw new AppError('VALIDATION', 'thinkingDepth 必须是 fast、balanced 或 deep。')
}

function parseReasoningLevel(value: unknown): ReasoningLevel | undefined {
  if (!isPresent(value)) return undefined
  if (
    value === 'off'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'ultra'
  ) return value
  throw new AppError('VALIDATION', 'reasoningLevel 必须是 off、low、medium、high 或 ultra。')
}

function optionalString(value: unknown): string {
  return isString(value) ? value : ''
}

function requireNonBlankString(value: unknown, message: string): string {
  if (!isNonBlankString(value)) throw new AppError('VALIDATION', message)
  return value.trim()
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new AppError('VALIDATION', message)
  return value
}

export { AgentModelRuntime }
export type { AgentProvider }
