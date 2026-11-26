import { Buffer } from 'node:buffer'

import { isArray, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { MediaGenerationResult } from '../../types/adapters'
import type { ChatProviderId, MediaGenerationKind } from '../../types/model'
import { readVideoGenerationJob } from '../../utils/wire/generated-media'

interface MediaProvider {
  provider: ChatProviderId
  baseURL: string
  apiKey: string
  model: string
  voice?: string
  fetch: typeof globalThis.fetch
}

/** 已解析的专用媒体生成端口，交给宿主执行一次请求。 */
export interface MediaGenerationApi {
  /** 本次专用生成模型产生的媒体形态。 */
  readonly kind: MediaGenerationKind
  /** 一次生成的完整产物，取消或失败时拒绝。 */
  generate(prompt: string, signal: AbortSignal): Promise<MediaGenerationResult>
}

/** 专用媒体端点的单轮调用，持有已经解析的供应商凭据和模型。 */
export class MediaGeneration implements MediaGenerationApi {
  private static readonly MaxVideoBytes = 64 * 1024 * 1024
  private static readonly MaxImageOrAudioBytes = 16 * 1024 * 1024
  private static readonly GenerationTimeoutMs = 20 * 60 * 1000
  private static readonly PollIntervalMs = 5000

  constructor(
    private readonly options: MediaProvider,
    public readonly kind: MediaGenerationKind
  ) {}

  /** 请求一次生成，直至本次产物完整返回或取消。 */
  public async generate(prompt: string, signal: AbortSignal): Promise<MediaGenerationResult> {
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(MediaGeneration.GenerationTimeoutMs),
    ])
    const { options, kind } = this
    const headers = { Authorization: `Bearer ${options.apiKey}` }
    const request = async (path: string, body?: Record<string, string>): Promise<Response> => {
      const response = await options.fetch(`${options.baseURL.replace(/\/+$/u, '')}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: requestSignal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new AppError('UNAVAILABLE', `媒体生成请求失败：HTTP ${response.status}`)
      }
      return response
    }
    if (kind === 'audio') {
      const response = await request('audio/speech', {
        model: options.model,
        input: prompt,
        voice: options.voice ?? 'alloy',
        response_format: 'mp3',
      })
      return this.readMedia(response, 'audio/mpeg', requestSignal)
    }
    if (kind === 'video') {
      const initial = readVideoGenerationJob(
        await (await request('videos', { model: options.model, prompt })).json()
      )
      const path = `videos/${encodeURIComponent(initial.id)}`
      let job = initial
      while (job.status !== 'completed') {
        if (!['queued', 'pending', 'processing', 'in_progress', 'running'].includes(job.status))
          throw new AppError('UNAVAILABLE', `视频生成结束，状态：${job.status}`)
        await TimerScope.sleep(MediaGeneration.PollIntervalMs, { signal: requestSignal })
        job = readVideoGenerationJob(await (await request(path)).json())
      }
      return this.readMedia(await request(`${path}/content`), 'video/mp4', requestSignal)
    }
    const isOpenRouter = options.provider === 'openrouter'
    const response = await request(isOpenRouter ? 'images' : 'images/generations', {
      model: options.model,
      prompt,
      ...(/^dall-e-/iu.test(options.model)
        ? { response_format: 'b64_json' }
        : { output_format: 'png' }),
    })
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(await this.readBytes(response, requestSignal))
    )
    const first = isPlainObject(payload) && isArray(payload.data) ? payload.data[0] : undefined
    if (!isPlainObject(first) || !isString(first.b64_json))
      throw new AppError('PROTOCOL', '图片服务未返回 Base64 图片。')
    const bytes = Buffer.from(first.b64_json, 'base64')
    if (!bytes.length) throw new AppError('PROTOCOL', '图片服务返回了空文件。')
    return { mediaType: 'image/png', bytes }
  }

  private async readMedia(
    response: Response,
    mediaType: string,
    signal: AbortSignal
  ): Promise<MediaGenerationResult> {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType && contentType !== 'application/octet-stream' && contentType !== mediaType) {
      await response.body?.cancel()
      throw new AppError('PROTOCOL', '生成文件的媒体类型不匹配。')
    }
    return {
      mediaType,
      bytes: await this.readBytes(response, signal),
    }
  }

  private async readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (!reader) throw new AppError('PROTOCOL', '媒体服务返回了空文件。')
    const chunks: Uint8Array[] = []
    let size = 0
    const maxBytes =
      this.kind === 'video' ? MediaGeneration.MaxVideoBytes : MediaGeneration.MaxImageOrAudioBytes
    try {
      for (;;) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw new AppError('LIMIT', '生成文件超过大小限制。')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    if (!size) throw new AppError('PROTOCOL', '媒体服务返回了空文件。')
    return Buffer.concat(chunks, size)
  }
}
