import { isPlainObject, toOptional, trimmedStringOrEmpty } from '@velaros-ai/core'

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
  /** 当前鉴权作用域目录声明的窗口；低于具体运行时 metadata，高于静态兜底。 */
  catalogContextWindow?: number
}

interface ConcreteProviderModelConfig {
  provider: string
  model: string
  contextWindow: Nullable<number>
}

function readConcreteProviderModelConfig(
  value: unknown
): ConcreteProviderModelConfig | undefined {
  if (!isPlainObject(value)) return undefined

  const provider = trimmedStringOrEmpty(value.provider)
  const model = trimmedStringOrEmpty(value.model)
  if (!provider || !model) return undefined

  return {
    provider,
    model,
    contextWindow: toPositiveInteger(value.contextWindow),
  }
}

/** 仅提取运行时明确声明的窗口，不把静态查表或默认估计升级为 metadata。 */
export function resolveProviderScriptMetadataContextWindow(
  metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
): number | undefined {
  return readConcreteProviderModelConfig(metadata?.config)?.contextWindow
    ?? toPositiveInteger(metadata?.contextWindow)
    ?? undefined
}

/**
 * 显式运行时窗口优先于当前鉴权作用域目录；缺失时再按具体 provider/model 静态查表。
 */
export function resolveProviderScriptContextWindow(
  input: ProviderScriptContextWindowInput
): number | undefined {
  const explicitWindow = resolveProviderScriptMetadataContextWindow(input.metadata)
  if (explicitWindow) return explicitWindow
  if (input.catalogContextWindow) return input.catalogContextWindow

  const concreteConfig = readConcreteProviderModelConfig(input.metadata?.config)
  if (concreteConfig) {
    const resolved = resolveProviderModelContextWindow(
      concreteConfig.provider,
      concreteConfig.model
    )
    if (resolved) return resolved
  }

  return toOptional(
    resolveProviderModelContextWindow(input.providerId, input.runtimeModel)
  )
}
