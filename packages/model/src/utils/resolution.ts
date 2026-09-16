import { isBlank, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes, ModelInputModalities } from '../contract/constants.js'
import type { ModelResolutionTraceEntry } from '../types/adapters'
import type { ChatProviderId, ModelInputModality, ModelRequestOptions } from '../types/model'

/** 元数据没说这个模型收什么输入时，按三种都可能试一次，别在本地就把请求挡掉。 */
export const UnknownModelInputModalities: readonly ModelInputModality[] = ModelInputModalities

/** 一次解析的轨迹：没回退就一行，回退了就"跳过原模型 + 选中新模型"两行。 */
export function buildResolutionTrace(
  provider: ChatProviderId,
  requestedModel: string,
  selectedModel: string,
  didFallback: boolean
): ModelResolutionTraceEntry[] {
  if (!didFallback) return [{ provider, model: selectedModel, status: 'selected' }]

  return [
    {
      provider,
      model: requestedModel,
      status: 'skipped',
      reason: '所选模型已不在当前 provider 的可用目录中',
    },
    { provider, model: selectedModel, status: 'selected' },
  ]
}

/** provider 不可用时的错误：给出自救动作，并说明本包不会自动换一家。 */
export function createUnavailableProviderError(provider: ChatProviderId): AppError {
  return new AppError(
    ModelErrorCodes.providerUnavailable,
    `当前 provider ${provider} 不可用。请确认它已启用，且 API Key、Base URL 或自定义 adapter 配置有效；Model Runtime 不会自动切换到其它 provider。`
  )
}

/** 把两条降级原因拼成一句；空的那条不占位。 */
export function mergeFallbackReason(
  primary: LooseOptional<string>,
  secondary: LooseOptional<string>
): string {
  return [primary, secondary]
    .map((reason) => reason?.trim() ?? '')
    .filter((reason) => !isBlank(reason))
    .join('；')
}

/** 把一层 providerOptions 合进请求选项；requestPolicy 原样保留。 */
export function mergeModelRequestOptions(
  requestOptions: LooseOptional<ModelRequestOptions>,
  providerOptions: Nullable<Record<string, unknown>>
): ModelRequestOptions | undefined {
  if (!providerOptions) return toOptional(requestOptions)

  return {
    ...(requestOptions ?? {}),
    requestPolicy: requestOptions?.requestPolicy,
    providerOptions: {
      ...(requestOptions?.providerOptions ?? {}),
      ...providerOptions,
    },
  }
}

/** 两层请求选项合并：后一层整体覆盖，providerOptions 做浅合并。 */
export function mergeModelRequestOptionLayers(
  primary: LooseOptional<ModelRequestOptions>,
  secondary: LooseOptional<ModelRequestOptions>
): ModelRequestOptions | undefined {
  if (!secondary) return toOptional(primary)
  if (!primary) return secondary

  return {
    ...primary,
    ...secondary,
    openRouter: secondary.openRouter ?? primary.openRouter,
    requestPolicy: secondary.requestPolicy ?? primary.requestPolicy,
    providerOptions: secondary.providerOptions
      ? {
          ...(primary.providerOptions ?? {}),
          ...secondary.providerOptions,
        }
      : primary.providerOptions,
  }
}
