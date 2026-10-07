import { AppError, createAbortError, createTimeoutError } from '@velaros-ai/core/error'
import type {
  ModelDriver,
  ModelInputEstimate,
  ModelTurnDelta,
  ModelTurnRequest,
} from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { ScriptActBridge } from '../contract/constants.js'
import type { ExternalModelDriverOptions } from '../contract/requires.js'
import type { ExternalModelPending, ExternalModelReply } from '../types.js'
import { externalModelImages, externalModelPrompt } from '../utils/encoding.js'

/** 为标准 Runtime 提供一个网页外部模型，保持同一 ScriptAct 接收与执行链。 */
export interface ExternalModelDriverApi extends ModelDriver {
  /** 受理有活动请求租约的完整响应；身份不符返回 false。 */
  deliver(reply: ExternalModelReply): boolean
  /** 撤销所有等待，拒绝关闭后的再次派发。 */
  close(): void
}

class ExternalModelDriver implements ExternalModelDriverApi {
  public readonly nativeTools = false
  public readonly id: string
  public readonly limits
  private readonly pending = new Map<string, ExternalModelPending>()
  private closed = false

  public constructor(private readonly options: ExternalModelDriverOptions) {
    this.id = options.id
    this.limits = options.limits
  }

  public async estimate(request: ModelTurnRequest): Promise<ModelInputEstimate> {
    if (this.options.estimate) return this.options.estimate(request)
    const bytes = new TextEncoder().encode(externalModelPrompt(request)).length
    // 一字节至少预留一个 token；真实用量仍由供应商回报，不能把估算写成已测用量。
    return {
      tokens: bytes + externalModelImages(request).length * ScriptActBridge.imageTokens,
      precision: 'estimate',
      basis: 'external-web:utf8-byte-upper-bound',
    }
  }

  public async *stream(
    request: ModelTurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelTurnDelta> {
    signal.throwIfAborted()
    if (this.closed) throw new AppError('CLOSED', '网页模型驱动已关闭')
    if (request.response.type === 'tools')
      throw new AppError('PROTOCOL', '网页模型通道只接受 text 或 json')
    const requestId = this.options.createId()
    const lease = this.options.createId()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const reply = await new Promise<ExternalModelReply>((resolve, reject) => {
        this.pending.set(requestId, { lease, resolve, reject })
        const revoke = (error: unknown) => {
          if (this.pending.get(requestId)?.lease === lease) this.pending.delete(requestId)
          reject(error)
        }
        onAbort = () => revoke(createAbortError('网页模型请求已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(
          () => revoke(createTimeoutError('网页模型请求超时')),
          this.options.timeoutMs ?? ScriptActBridge.requestTimeoutMs
        )
        // 先登记租约，再发送；同步返回也只能交给这一请求。
        void this.options
          .send({
            requestId,
            lease,
            request,
            prompt: externalModelPrompt(request),
            images: externalModelImages(request),
          })
          .catch(revoke)
        if (signal.aborted) onAbort()
      })
      signal.throwIfAborted()
      if (reply.type === 'failed') {
        if (
          typeof reply.code !== 'string' ||
          !reply.code ||
          reply.code.length > 128 ||
          typeof reply.message !== 'string' ||
          !reply.message ||
          reply.message.length > 8000
        )
          throw new AppError('PROTOCOL', '网页模型错误消息无效')
        throw new AppError(reply.code, reply.message)
      }
      if (
        reply.type !== 'finished' ||
        typeof reply.evidence !== 'string' ||
        !reply.evidence.trim() ||
        reply.evidence.length > 128 ||
        !['stop', 'length'].includes(reply.reason) ||
        typeof reply.text !== 'string' ||
        reply.text.length > ScriptActBridge.maxResponseChars
      )
        throw new AppError('PROTOCOL', '网页模型回复缺少有效的完整结束事实')
      if (request.response.type === 'json') {
        let value: unknown
        try {
          value = JSON.parse(reply.text)
        } catch {
          throw new AppError('PROTOCOL', '网页模型没有返回完整 JSON')
        }
        yield { type: 'output', value: modelRequestEncoder.output(request.response, value) }
      } else yield { type: 'text', text: reply.text }
      yield { type: 'finish', reason: reply.reason }
    } finally {
      this.pending.delete(requestId)
      if (timer) clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
      await this.options.cancel(requestId, lease)
    }
  }

  public deliver(reply: ExternalModelReply): boolean {
    const pending = this.pending.get(reply.requestId)
    if (!pending || pending.lease !== reply.lease) return false
    this.pending.delete(reply.requestId)
    pending.resolve(reply)
    return true
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values())
      pending.reject(new AppError('CLOSED', '网页模型通道已断开'))
    this.pending.clear()
  }
}

/** 构造一个固定通道驱动；任务、上下文与效果仍由标准 Runtime 持有。 */
export function createExternalModelDriver(
  options: ExternalModelDriverOptions
): ExternalModelDriverApi {
  return new ExternalModelDriver(options)
}
