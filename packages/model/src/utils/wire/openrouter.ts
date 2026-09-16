import { isArray, isBlank, isEmpty, isPlainObject } from '@velaros-ai/core'

import { OpenRouterAutoModelId, OpenRouterFreeModelId } from '../../contract/constants.js'
import type { ModelRequestOptions, OpenRouterProviderRoutingPreferences, ReasoningLevel, ThinkingDepth } from '../../types/model'
import type { OpenRouterRequestRouting } from '../../types/providers'

import { isReasoningDisabledByLevel } from './reasoning'

/** OpenRouter 自动路由到的模型可能带推理能力，按这些模式名判要不要注入 reasoning。 */
const OpenRouterReasoningModelMatchers = [
  /claude-(?:opus|sonnet|haiku)-(?:latest|4(?:[.-]\d+)?)/i,
  /claude-(?:4(?:[.-]\d+)?)-(?:opus|sonnet|haiku)/i,
  /claude-(?:3[.-]7-sonnet|sonnet-3[.-]7)/i,
  /gemini-(?:2\.5|3(?:[.-]|$))/i,
  /(?:^|\/)o[34](?:-|$)/i,
  /gpt-[45]|gpt-oss/i,
  /reasoner|reasoning|thinking/i,
]

/** 这个模型名看起来会不会走推理。 */
export function matchesOpenRouterReasoningModel(model: string): boolean {
  return OpenRouterReasoningModelMatchers.some((matcher) => matcher.test(model))
}

/** 过滤空模型、auto/free 两个特殊模型并去重，剩下的才是 auto-router 的白名单。 */
export function normalizeOpenRouterAllowedModels(models: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  models.forEach((model) => {
    const trimmed = model.trim()
    if (
      isBlank(trimmed) ||
      trimmed === OpenRouterAutoModelId ||
      trimmed === OpenRouterFreeModelId ||
      seen.has(trimmed)
    ) return

    seen.add(trimmed)
    normalized.push(trimmed)
  })

  return normalized
}

/** 合并 OpenRouter auto-router 插件，并移除旧的 auto-router 避免重复。 */
export function mergeOpenRouterAutoRouterPlugin(
  plugins: unknown,
  allowedModels: string[]
): Array<Record<string, unknown>> {
  const existingPlugins = isArray(plugins)
    ? plugins.filter(
        (plugin): plugin is Record<string, unknown> =>
          isPlainObject(plugin) && plugin.id !== 'auto-router'
      )
    : []

  return [
    ...existingPlugins,
    {
      id: 'auto-router',
      allowed_models: allowedModels,
    },
  ]
}

/** 合并 OpenRouter provider 偏好；调用方给的字段覆盖请求体里已有的同名字段。 */
export function mergeOpenRouterProviderPreferences(
  provider: unknown,
  providerPreferences: OpenRouterProviderRoutingPreferences
): Record<string, unknown> {
  const existingProvider = isPlainObject(provider) ? provider : {}

  return {
    ...existingProvider,
    ...providerPreferences,
  }
}

/** auto 模型加上非空白名单时才注入 auto-router 插件。 */
export function shouldInjectAutoRouterPlugin(model: string, allowedModels: string[]): boolean {
  return model === OpenRouterAutoModelId && !isEmpty(allowedModels)
}

/** 把一次调用的 OpenRouter 选项归一成路由配置：调试免费模型优先，其余按模型与白名单算。 */
export function normalizeOpenRouterRouting(
  modelId: string,
  options: Optional<ModelRequestOptions>,
  depths: {
    thinkingDepth?: LooseOptional<ThinkingDepth>
    reasoningLevel?: LooseOptional<ReasoningLevel>
  }
): OpenRouterRequestRouting {
  const routing = options?.openRouter
  const useFreeModelsForDebug = !!routing?.useFreeModelsForDebug

  if (useFreeModelsForDebug) return {
      model: OpenRouterFreeModelId,
      allowedModels: [],
      useFreeModelsForDebug,
      thinkingDepth: depths.thinkingDepth,
      reasoningLevel: depths.reasoningLevel,
    }

  return {
    model: modelId.trim() || OpenRouterAutoModelId,
    allowedModels: normalizeOpenRouterAllowedModels(routing?.allowedModels ?? []),
    providerPreferences: routing?.providerPreferences,
    useFreeModelsForDebug,
    thinkingDepth: depths.thinkingDepth,
    reasoningLevel: depths.reasoningLevel,
  }
}

/**
 * 仅在 OpenRouter 支持或可能自动路由到 reasoning 模型时注入运行策略。
 *
 * off 档没有 thinkingDepth 也要注入：`reasoning: { enabled: false, exclude: true }` 是 OpenRouter 的关闭
 * 写法，不发它等于把开关交还给上游模型的默认值（新一代模型默认思考），用户选的"关"就不生效。
 */
export function shouldInjectOpenRouterReasoning(routing: OpenRouterRequestRouting): boolean {
  if (routing.useFreeModelsForDebug) return false
  if (!routing.thinkingDepth && !isReasoningDisabledByLevel(routing.reasoningLevel)) return false

  if (routing.model === OpenRouterAutoModelId) return (
      isEmpty(routing.allowedModels) ||
      routing.allowedModels.some((model) => matchesOpenRouterReasoningModel(model))
    )

  return matchesOpenRouterReasoningModel(routing.model)
}
