import { resolveProviderModelContextWindow } from './ModelCatalog'
import type { ChatProviderId } from './ModelContracts'

import {
  type ProviderScriptRuntimeMetadata,
  toPositiveInteger,
} from './ProviderScriptRegistryPort'

interface ProviderScriptContextWindowInput {
  providerId: ChatProviderId
  runtimeModel: string
  metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
}

interface ConcreteProviderModelConfig {
  provider: string
  model: string
  contextWindow: Nullable<number>
}

function readConcreteProviderModelConfig(
  value: unknown
): ConcreteProviderModelConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (!provider || !model) return undefined

  return {
    provider,
    model,
    contextWindow: toPositiveInteger(record.contextWindow),
  }
}

/**
 * Provider script 若保留了实际 provider/model 配置，则先尊重服务端显式窗口，
 * 否则由 Desktop 模型目录解析真实模型；未知模型继续使用脚本自己的安全回退。
 */
export function resolveProviderScriptContextWindow(
  input: ProviderScriptContextWindowInput
): number | undefined {
  const concreteConfig = readConcreteProviderModelConfig(input.metadata?.config)
  if (concreteConfig?.contextWindow) return concreteConfig.contextWindow

  if (concreteConfig) {
    const resolved = resolveProviderModelContextWindow(
      concreteConfig.provider,
      concreteConfig.model
    )
    if (resolved) return resolved
  }

  if (input.metadata?.contextWindow) return input.metadata.contextWindow

  const resolvedFallback = resolveProviderModelContextWindow(
    input.providerId,
    input.runtimeModel
  )
  return resolvedFallback === null ? undefined : resolvedFallback
}
