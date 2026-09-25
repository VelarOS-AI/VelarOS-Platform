import { isNull, isNumber, isString, toNullable } from '@velaros-ai/core'

import { ReasoningLevels } from '../../contract/constants'
import type { OpenAIModelFetch } from '../../types/adapters'
import type { ChatProviderId, ReasoningLevel } from '../../types/model'
import { chatReasoningFields } from '../../utils/wire/chat-reasoning'
import {
  isChatCompletionsRequest,
  mergeJsonRequestBody,
  readJsonRequestBody,
} from '../../utils/wire/fetch-shims'
import { isReasoningRejected, isReasoningRejection } from '../../utils/wire/reasoning'

/**
 * 思考参数被拒时的退档重发，一份运行时对象图一份，不跨图共享。
 *
 * 发了型号不认的思考参数，整条请求会被拒：往下退一档重发，退到底就不带思考参数发；能用的那一档按
 * `key`（供应商与型号）记下来，同一个型号之后直接从这一档发，不再重复被拒。
 */
export interface ReasoningFallbackApi {
  /**
   * 从 `level` 发起调用（与记住的上限取低）；因思考参数被拒就往下退一档再调，`attempt` 收到 null 时表示
   * 不带思考参数。被拒有两种形状：SDK 抛出的调用错误，或 `rejected` 认出的响应。`signature` 给出这一档
   * 实际要发的参数，与上一次被拒的一样时直接跳过，与不带思考参数一样时这就是最后一次。
   */
  run<T>(
    key: string,
    level: ReasoningLevel,
    attempt: (level: Nullable<ReasoningLevel>) => PromiseLike<T>,
    options?: {
      signature?: (level: Nullable<ReasoningLevel>) => string
      rejected?: (result: T) => Promise<boolean>
    }
  ): Promise<T>
  /** 给走 Chat Completions 的供应商包一层 fetch：把这一档的思考参数写进请求体，被拒就退档重发。 */
  chatFetch(options: {
    provider: ChatProviderId
    level: ReasoningLevel
    fetch?: OpenAIModelFetch
  }): OpenAIModelFetch
}

export class ReasoningFallback implements ReasoningFallbackApi {
  private readonly limits = new Map<string, Nullable<ReasoningLevel>>()

  public async run<T>(
    key: string,
    level: ReasoningLevel,
    attempt: (level: Nullable<ReasoningLevel>) => PromiseLike<T>,
    options: {
      signature?: (level: Nullable<ReasoningLevel>) => string
      rejected?: (result: T) => Promise<boolean>
    } = {}
  ): Promise<T> {
    const bare = options.signature?.(null)
    let current = this.start(key, level)
    let rejectedSignature: Optional<string>
    for (;;) {
      const signature = options.signature?.(current)
      if (!isNull(current) && isString(signature) && signature === rejectedSignature) {
        current = this.lower(key, current)
        continue
      }
      // 不带思考参数、或这一档与不带思考参数发的一样：这就是最后一次，被拒也原样交出去
      const tried: Nullable<ReasoningLevel> =
        isString(signature) && signature === bare ? null : current
      let result: T
      try {
        result = await attempt(current)
      } catch (error) {
        if (isNull(tried) || !isReasoningRejection(error)) throw error
        rejectedSignature = signature
        current = this.lower(key, tried)
        continue
      }
      if (isNull(tried) || !(await options.rejected?.(result))) return result
      rejectedSignature = signature
      current = this.lower(key, tried)
    }
  }

  public chatFetch({
    provider,
    level,
    fetch = (input, init) => globalThis.fetch(input, init),
  }: {
    provider: ChatProviderId
    level: ReasoningLevel
    fetch?: OpenAIModelFetch
  }): OpenAIModelFetch {
    return async (input, init) => {
      const body = readJsonRequestBody(init)
      const model = isString(body?.model) ? body.model : ''
      if (!isChatCompletionsRequest(input) || !model) return fetch(input, init)

      const maxOutputTokens = [body?.max_completion_tokens, body?.max_tokens].find(isNumber)
      const fieldsAt = (current: Nullable<ReasoningLevel>) =>
        isNull(current) ? null : chatReasoningFields(provider, model, current, maxOutputTokens)
      return this.run(
        `${provider}:${model}`,
        level,
        (current) => {
          const fields = fieldsAt(current)
          // 调用方已经写进请求体的同名字段优先，不覆盖显式意图。
          return fetch(
            input,
            fields ? mergeJsonRequestBody(init, (base) => ({ ...fields, ...base })) : init
          )
        },
        { signature: (current) => JSON.stringify(fieldsAt(current)), rejected: isReasoningRejected }
      )
    }
  }

  /** 这次该从哪一档发：选的档与记住的上限取低；记住的是「不带思考参数」时返回 null。 */
  private start(key: string, level: ReasoningLevel): Nullable<ReasoningLevel> {
    if (!this.limits.has(key)) return level
    const limit = toNullable(this.limits.get(key))
    if (isNull(limit)) return null

    return ReasoningLevels.indexOf(level) > ReasoningLevels.indexOf(limit) ? limit : level
  }

  /** `rejected` 这一档被拒了：记住下一档（退到底就是不带思考参数）并返回它。 */
  private lower(key: string, rejected: ReasoningLevel): Nullable<ReasoningLevel> {
    const next = toNullable(ReasoningLevels[ReasoningLevels.indexOf(rejected) - 1])
    this.limits.set(key, next)

    return next
  }
}
