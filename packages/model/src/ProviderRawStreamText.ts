import { isArray, isNull, isPlainObject, isString } from '@velaros-ai/core'

/**
 * 从服务商**原始流分片**里抠出可见正文与思考文本。
 *
 * 导览（§5.3b ①算法与协议）——AI SDK 会把它不认识的字段丢掉，所以 reasoning 这类各家自定义的
 * 内容只能从 raw chunk 里自己解。本文件同时认三套线上方言，且**只按结构判、不按 provider 判**
 * （raw chunk 到这里已经没有 provider 身份了；OpenRouter 还会把上游方言原样透传）：
 * 1. **Anthropic SSE**：`content_block_start` / `content_block_delta` / `message_start`，
 *    正文在 `delta.text` / `content_block.text`，思考在 `delta.thinking`；
 * 2. **OpenAI Responses**：`response.output_text.delta` / `response.reasoning_summary_text.delta`
 *    与收尾的 `response.output_item.done`；
 * 3. **OpenAI chat-completions**：`choices[].delta` / `choices[].message`，思考字段在各家网关里有
 *    八种拼法（`reasoning_content` / `reasoningContent` / `reasoning` / `thinking` / …），全部并列尝试。
 *
 * **不变量**：任何认不出的分片一律返回**空串**，绝不抛错、绝不返回占位——这条流是逐分片拼接的，
 * 一次异常会打断整轮输出，一个占位字符会永久留在正文里（§2.4 失败方向）。因此新增方言只允许
 * 往"再多认一种"的方向加分支，不允许改这条兜底。
 *
 * **顺序要求**：三套方言按上面的次序试，先命中先返回。Anthropic 必须早于 `choices`，
 * 因为部分网关会同时给出两种形状而 `choices` 里那份是被截断的摘要。
 */
class ProviderRawStreamText {
  public extractReasoningDeltaFromRawChunk(rawValue: unknown): string {
    if (!isPlainObject(rawValue)) return ''

    const record = rawValue
    const anthropicReasoningText = this.extractAnthropicReasoningText(record)
    if (anthropicReasoningText) return anthropicReasoningText

    const responseReasoningText = this.extractResponsesReasoningText(record)
    if (responseReasoningText) return responseReasoningText

    const choices = record.choices
    if (!isArray(choices)) return ''

    return choices
      .map((choice) => {
        if (!isPlainObject(choice)) return ''

        const record = choice.delta
        if (!isPlainObject(record)) return ''

        return (
          this.readReasoningText(record.reasoning_content) ||
          this.readReasoningText(record.reasoningContent) ||
          this.readReasoningText(record.reasoning) ||
          this.readReasoningText(record.thinking) ||
          this.readReasoningText(record.thought) ||
          this.readReasoningText(record.thoughts) ||
          this.readReasoningText(record.reasoning_details) ||
          this.readReasoningText(record.reasoningDetails)
        )
      })
      .join('')
  }

  public extractVisibleTextFromRawChunk(rawValue: unknown): string {
    if (!isPlainObject(rawValue)) return ''

    const record = rawValue
    const anthropicText = this.extractAnthropicVisibleText(record)
    if (anthropicText) return anthropicText

    const responseText = this.extractResponsesVisibleText(record)
    if (responseText) return responseText

    const choices = record.choices
    if (!isArray(choices)) return ''

    return choices
      .map((choice) => {
        if (!isPlainObject(choice)) return ''

        const choiceRecord = choice
        return [
          this.extractChoiceVisibleText(choiceRecord.delta),
          this.extractChoiceVisibleText(choiceRecord.message),
        ].join('')
      })
      .join('')
  }

  private extractResponsesReasoningText(record: Record<string, unknown>): string {
    switch (record.type) {
      case 'response.reasoning_summary_text.delta':
        return this.readReasoningText(record.delta)
      case 'response.output_item.done':
        return this.extractResponseReasoningItemText(record.item)
      default:
        return ''
    }
  }

  private extractAnthropicReasoningText(record: Record<string, unknown>): string {
    const type = record.type
    switch (type) {
      case 'content_block_delta':
      case 'content_block_start':
        break
      default:
        return ''
    }

    const delta = isPlainObject(record.delta) ? record.delta : null
    const contentBlock = isPlainObject(record.content_block) ? record.content_block : null
    const deltaType = isString(delta?.type) ? delta.type : null
    const contentBlockType = isString(contentBlock?.type) ? contentBlock.type : null

    if (deltaType === 'thinking_delta') return (
        this.readReasoningText(delta?.thinking) ||
        this.readReasoningText(delta?.thought) ||
        this.readReasoningText(delta?.text)
      )

    if (contentBlockType === 'thinking' || contentBlockType === 'redacted_thinking') return (
        this.readReasoningText(contentBlock?.thinking) || this.readReasoningText(contentBlock?.text)
      )

    return ''
  }

  private extractResponseReasoningItemText(item: unknown): string {
    if (!isPlainObject(item) || item.type !== 'reasoning') return ''

    return this.readReasoningText(item.summary)
  }

  private extractResponsesVisibleText(record: Record<string, unknown>): string {
    const type = record.type
    switch (type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return this.readVisibleText(record.delta)
      case 'response.output_item.done':
        return this.extractResponseOutputItemText(record.item)
      default:
        return ''
    }
  }

  private extractAnthropicVisibleText(record: Record<string, unknown>): string {
    const type = record.type
    switch (type) {
      case 'content_block_delta':
      case 'content_block_start':
      case 'message_start':
        break
      default:
        return ''
    }

    const delta = isPlainObject(record.delta) ? record.delta : null
    const contentBlock = isPlainObject(record.content_block) ? record.content_block : null
    const message = isPlainObject(record.message) ? record.message : null
    const deltaType = isString(delta?.type) ? delta.type : null
    const contentBlockType = isString(contentBlock?.type) ? contentBlock.type : null

    switch (type) {
      case 'content_block_delta':
        return deltaType === 'text_delta' || isNull(deltaType)
          ? this.readVisibleText(delta?.text)
          : ''
      case 'content_block_start':
        return contentBlockType === 'text' || isNull(contentBlockType)
          ? this.readVisibleText(contentBlock?.text)
          : ''
      default:
        return this.readVisibleText(message?.content)
    }
  }

  private extractResponseOutputItemText(item: unknown): string {
    if (!isPlainObject(item) || item.type !== 'message') return ''

    return this.readVisibleText(item.content)
  }

  private extractChoiceVisibleText(value: unknown): string {
    if (!isPlainObject(value)) return ''

    return [this.readVisibleText(value.refusal), this.readVisibleText(value.content)].join('')
  }

  private readVisibleText(value: unknown): string {
    if (isString(value)) return value

    if (isArray(value)) return value.map((item) => this.readVisibleText(item)).join('')

    if (!isPlainObject(value)) return ''

    return this.readVisibleText(value.text) || this.readVisibleText(value.content)
  }

  private readReasoningText(value: unknown): string {
    if (isString(value)) return value

    if (isArray(value)) return value.map((item) => this.readReasoningText(item)).join('')

    if (!isPlainObject(value)) return ''

    return (
      this.readReasoningText(value.text) ||
      this.readReasoningText(value.content) ||
      this.readReasoningText(value.summary) ||
      this.readReasoningText(value.delta)
    )
  }
}

export { ProviderRawStreamText }
