import {
  isArray,
  isBlank,
  isEmpty,
  isPlainObject,
  isString,
  optionalWhen,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  ChatProviderId,
  ModelInputModality,
  ModelProviderValidationKind,
  ProviderModelCatalog,
} from '../types/model'
import type { ProviderModelListRequest, RemoteProviderModelEntry } from '../types/providers'

import { toPositiveInteger } from './numbers'
import { ModelTuning } from './tuning'

/** 这类 provider 有没有可以列模型的远端 `/models`。 */
export function canListRemoteProviderModels(validationKind: ModelProviderValidationKind): boolean {
  return (
    validationKind === 'openrouter-key' ||
    validationKind === 'openai-compatible-models' ||
    validationKind === 'anthropic-models' ||
    validationKind === 'google-models'
  )
}

/** 在 baseURL 后面接一段路径；协议不是 http/https 一律拒，别让目录地址变成本地文件读取。 */
function appendPath(baseURL: string, path: string): string {
  let end = baseURL.length
  while (end > 0 && baseURL[end - 1] === '/') end -= 1
  const url = new URL(`${baseURL.slice(0, end)}/${path}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION', `模型目录地址协议不受支持：${url.protocol}`)
  }
  return url.toString()
}

/** 有 key 才加 Bearer 头，没有就不加（本地服务收到空 Bearer 会当非法凭据）。 */
function optionalBearerHeader(apiKey: string): Array<[string, string]> {
  return isBlank(apiKey) ? [] : [['Authorization', `Bearer ${apiKey}`]]
}

/** 值非空才加这个头。 */
function optionalHeader(name: string, value?: string): Array<[string, string]> {
  const normalized = value?.trim() ?? ''
  return normalized ? [[name, normalized]] : []
}

/** 按 provider 的校验方式拼出列模型请求：各家的鉴权位置与查询参数都不一样。 */
export function createProviderModelListRequest(
  request: { readonly apiKey: string },
  baseURL: string,
  validationKind: ModelProviderValidationKind,
  attribution: { readonly referer?: string; readonly title?: string }
): ProviderModelListRequest {
  switch (validationKind) {
    case 'anthropic-models':
      return {
        url: appendPath(baseURL, 'models'),
        headers: [
          ['Content-Type', 'application/json'],
          ['anthropic-version', '2023-06-01'],
          ['x-api-key', request.apiKey],
        ],
      }

    case 'google-models': {
      const url = new URL(appendPath(baseURL, 'models'))
      url.searchParams.set('key', request.apiKey)
      url.searchParams.set('pageSize', String(ModelTuning.catalog.googlePageSize))
      return {
        url: url.toString(),
        headers: [['Content-Type', 'application/json']],
      }
    }

    case 'openrouter-key':
      return {
        url: appendPath(baseURL, 'models'),
        headers: [
          ...optionalBearerHeader(request.apiKey),
          ['Content-Type', 'application/json'],
          ...optionalHeader('HTTP-Referer', attribution.referer),
          ...optionalHeader('X-Title', attribution.title),
        ],
      }

    case 'openai-compatible-models':
    default:
      return {
        url: appendPath(baseURL, 'models'),
        headers: [...optionalBearerHeader(request.apiKey), ['Content-Type', 'application/json']],
      }
  }
}

/** 验证凭据沿用目录协议；OpenRouter 必须探测鉴权端点，公共目录成功不能证明密钥有效。 */
export function createProviderValidationRequest(
  request: { readonly apiKey: string },
  baseURL: string,
  validationKind: ModelProviderValidationKind,
  attribution: { readonly referer?: string; readonly title?: string }
): ProviderModelListRequest {
  const probe = createProviderModelListRequest(request, baseURL, validationKind, attribution)
  if (validationKind === 'openrouter-key') return { ...probe, url: appendPath(baseURL, 'key') }
  if (validationKind === 'google-models') {
    const url = new URL(probe.url)
    url.searchParams.delete('pageSize')
    return { ...probe, url: url.toString() }
  }
  return probe
}

/** 这个值是不是本包认的输入形态。 */
function isModelInputModality(value: unknown): value is ModelInputModality {
  return value === 'text' || value === 'image' || value === 'audio'
}

/** 从远端 `/models` 响应里读出模型条目；Google 与 OpenAI 系的包装形状不同。 */
export function readRemoteModelEntries(
  validationKind: ModelProviderValidationKind,
  payload: unknown
): RemoteProviderModelEntry[] {
  if (!isPlainObject(payload)) return []

  if (validationKind === 'google-models')
    return isArray(payload.models)
      ? payload.models.flatMap((item): RemoteProviderModelEntry[] => {
          if (!isPlainObject(item)) return []
          const rawName = isString(item.name) ? item.name : ''
          const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName
          if (!id.trim()) return []
          return [
            {
              id,
              label: optionalWhen(isString, item.displayName),
              contextWindow: toOptional(toPositiveInteger(item.inputTokenLimit)),
            },
          ]
        })
      : []

  return isArray(payload.data)
    ? payload.data.flatMap((item): RemoteProviderModelEntry[] => {
        if (!isPlainObject(item) || !isString(item.id) || !item.id.trim()) return []
        const architecture = isPlainObject(item.architecture) ? item.architecture : null
        const inputModalities =
          architecture && isArray(architecture.input_modalities)
            ? architecture.input_modalities.filter(isModelInputModality)
            : []
        return [
          {
            id: item.id,
            contextWindow: toOptional(
              toPositiveInteger(item.context_length ?? item.context_window)
            ),
            label: [item.display_name, item.displayName, item.name].find(isString),
            inputModalities: optionalWhen(!isEmpty(inputModalities), inputModalities),
          },
        ]
      })
    : []
}

/** 一份空的远端目录，带上失败原因；调用方据此显示"这次没拿到"。 */
export function createEmptyRemoteCatalog(
  provider: ChatProviderId,
  fetchedAt: number,
  error: string
): ProviderModelCatalog {
  return {
    provider,
    source: 'remote',
    models: [],
    fetchedAt,
    error,
  }
}

/** 把服务端的错误正文压成一句可读的话；401 与鉴权类一律归到"API Key 不可用"。 */
export function normalizeProviderErrorMessage(
  providerLabel: string,
  status: number,
  rawText: string
): string {
  const text = rawText.trim()
  let message = text

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string }
      message?: string
    }
    message = parsed.error?.message || parsed.message || text
  } catch {
    // arch-guard:silent-catch-ok Provider 错误正文允许是纯文本或 HTML；下方仍会归一化并返回明确错误。
  }

  if (
    status === 401 ||
    /missing authentication header|invalid api key|authentication/iu.test(message)
  )
    return `${providerLabel} API Key 不可用`
  return message ? message.slice(0, ModelTuning.catalog.errorMessageChars) : `HTTP ${status}`
}
