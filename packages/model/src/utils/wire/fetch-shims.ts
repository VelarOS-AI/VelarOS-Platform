import { isBlank, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelTuning } from '../tuning'

/** 移除 AI SDK 在没有 key 时自动生成的空 Bearer 头；本地服务收到它会当成非法凭据。 */
export function stripBlankAuthorization<TInit extends { headers?: HeadersInit }>(
  init: Optional<TInit>
): Optional<TInit> {
  if (!init?.headers) return init

  const headers = new Headers(init.headers)
  const authorization = headers.get('Authorization') ?? ''

  if (authorization.trim() === 'Bearer') {
    headers.delete('Authorization')
  }

  return {
    ...init,
    headers,
  }
}

/** 这次请求是不是打到 chat/completions；只有它接受 Ollama 的 `options.num_ctx`。 */
export function isChatCompletionsRequest(input: unknown): boolean {
  const url = input instanceof Request ? input.url : isString(input) ? input : String(input)

  return /\/chat\/completions(?:\?|$)/u.test(url)
}

/** 把 Ollama 的原生 `options.num_ctx` 注进请求体；注不进去就原样放行，不让兼容层把请求打坏。 */
export function injectOllamaContextWindow<TInit extends object>(
  init: Optional<TInit>,
  contextWindow: number
): Optional<TInit> {
  const rawBody = (init as { body?: unknown } | undefined)?.body
  if (!isString(rawBody)) return init

  try {
    const body = JSON.parse(rawBody)
    if (!isPlainObject(body)) return init

    const options = isPlainObject(body.options) ? body.options : {}
    return {
      ...init,
      body: JSON.stringify({
        ...body,
        options: {
          ...options,
          num_ctx: contextWindow,
        },
      }),
    } as TInit
  } catch (error) {
    Log.tag('OpenAICompatibleModelAdapter').debug('注入 Ollama 上下文窗口失败，保留原始请求体', {
      error,
    })
    return init
  }
}

/** 往 JSON 请求体里合并几个顶层字段；解析不出 JSON 时原样放行，不让兼容层把请求打坏。 */
export function mergeJsonRequestBody<TInit extends object>(
  init: Optional<TInit>,
  merge: (body: Record<string, unknown>) => Record<string, unknown>
): Optional<TInit> {
  const rawBody = (init as { body?: unknown } | undefined)?.body
  if (!isString(rawBody)) return init

  try {
    const body = JSON.parse(rawBody)
    if (!isPlainObject(body)) return init

    return {
      ...init,
      body: JSON.stringify(merge(body)),
    } as TInit
  } catch (error) {
    Log.tag('OpenAIModelAdapter').debug('注入 OpenRouter 路由请求体失败，保留原始初始化参数', {
      error,
    })
    return init
  }
}

/** 取错误响应的正文做诊断；读不出来（已被消费、非文本）时不让诊断本身再抛一次。 */
export async function readResponseSummary(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    return isBlank(text)
      ? '服务端未返回正文'
      : text.slice(0, ModelTuning.errors.velarEmbeddingSummaryChars)
  } catch (error) {
    Log.tag('VelarModelAdapter').debug('读取 Velar embedding 失败响应正文失败', { error })
    return '服务端未返回可读正文'
  }
}

/** 用宿主注入的带账户认证 fetch 发一次 Velar embedding；失败时把服务端正文压进错误文案。 */
export async function postVelarEmbedding(
  runtimeFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const response = await runtimeFetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new AppError(
      'NETWORK',
      `Velar embedding 请求失败（HTTP ${response.status}）：${await readResponseSummary(response)}`
    )
  }

  return response.json()
}
