import { AppError } from '@velaros-ai/core/error'

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
  ReasoningLevel,
  ThinkingDepth,
} from './ModelContracts'

type AgentProvider = LanguageModelFactory

/**
 * Opaque Agent-facing facade. Parsing happens at this boundary so provider
 * details never become an Agent/Core contract.
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
    providerScript:
      isRecord(record.providerScript)
        ? (record.providerScript as unknown as AgentProviderRuntimeConfig['providerScript'])
        : undefined,
  }
}

function parseAdapter(value: unknown): AgentProviderAdapterConfig | undefined {
  if (value == null) return undefined
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
  if (value == null) return undefined
  if (value === 'fast' || value === 'balanced' || value === 'deep') return value
  throw new AppError('VALIDATION', 'thinkingDepth 必须是 fast、balanced 或 deep。')
}

function parseReasoningLevel(value: unknown): ReasoningLevel | undefined {
  if (value == null) return undefined
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
  return typeof value === 'string' ? value : ''
}

function requireNonBlankString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION', message)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AppError('VALIDATION', message)
  return value
}

export { AgentModelRuntime }
export type { AgentProvider }
