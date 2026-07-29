import {
  isArray,
  isNull,
  isObject,
  isPlainObject,
  isString,
} from '@velaros-ai/core'

/**
 * Agent stream 对 provider raw chunk 的容错文本投影。
 *
 * 这是 Agent 流消费语义，不依赖具体 Model registry/provider 创建实现。
 */
class AgentRawStreamTextExtractor {
  public extractReasoningDeltaFromRawChunk(rawValue: unknown): string {
    if (!rawValue || !isObject(rawValue)) return ''

    const record = rawValue as Record<string, unknown>
    const anthropicReasoningText = this.extractAnthropicReasoningText(record)
    if (anthropicReasoningText) return anthropicReasoningText

    const responseReasoningText = this.extractResponsesReasoningText(record)
    if (responseReasoningText) return responseReasoningText

    const choices = record.choices
    if (!isArray(choices)) return ''

    return choices
      .map((choice) => {
        if (!choice || !isObject(choice)) return ''

        const delta = (choice as { delta?: unknown }).delta
        if (!delta || !isObject(delta)) return ''

        const deltaRecord = delta as Record<string, unknown>
        return (
          this.readReasoningText(deltaRecord.reasoning_content) ||
          this.readReasoningText(deltaRecord.reasoningContent) ||
          this.readReasoningText(deltaRecord.reasoning) ||
          this.readReasoningText(deltaRecord.thinking) ||
          this.readReasoningText(deltaRecord.thought) ||
          this.readReasoningText(deltaRecord.thoughts) ||
          this.readReasoningText(deltaRecord.reasoning_details) ||
          this.readReasoningText(deltaRecord.reasoningDetails)
        )
      })
      .join('')
  }

  public extractVisibleTextFromRawChunk(rawValue: unknown): string {
    if (!rawValue || !isObject(rawValue)) return ''

    const record = rawValue as Record<string, unknown>
    const anthropicText = this.extractAnthropicVisibleText(record)
    if (anthropicText) return anthropicText

    const responseText = this.extractResponsesVisibleText(record)
    if (responseText) return responseText

    const choices = record.choices
    if (!isArray(choices)) return ''

    return choices
      .map((choice) => {
        if (!choice || !isObject(choice)) return ''

        const choiceRecord = choice as Record<string, unknown>
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
    switch (record.type) {
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

    if (deltaType === 'thinking_delta')
      return (
        this.readReasoningText(delta?.thinking) ||
        this.readReasoningText(delta?.thought) ||
        this.readReasoningText(delta?.text)
      )

    if (contentBlockType === 'thinking' || contentBlockType === 'redacted_thinking')
      return (
        this.readReasoningText(contentBlock?.thinking) ||
        this.readReasoningText(contentBlock?.text)
      )

    return ''
  }

  private extractResponseReasoningItemText(item: unknown): string {
    if (!item || !isObject(item)) return ''

    const record = item as Record<string, unknown>
    return record.type === 'reasoning' ? this.readReasoningText(record.summary) : ''
  }

  private extractResponsesVisibleText(record: Record<string, unknown>): string {
    switch (record.type) {
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
    if (!item || !isObject(item)) return ''

    const record = item as Record<string, unknown>
    return record.type === 'message' ? this.readVisibleText(record.content) : ''
  }

  private extractChoiceVisibleText(value: unknown): string {
    if (!value || !isObject(value)) return ''

    const record = value as Record<string, unknown>
    return [this.readVisibleText(record.refusal), this.readVisibleText(record.content)].join('')
  }

  private readVisibleText(value: unknown): string {
    if (isString(value)) return value
    if (isArray(value)) return value.map((item) => this.readVisibleText(item)).join('')
    if (!value || !isObject(value)) return ''

    const record = value as Record<string, unknown>
    return this.readVisibleText(record.text) || this.readVisibleText(record.content)
  }

  private readReasoningText(value: unknown): string {
    if (isString(value)) return value
    if (isArray(value)) return value.map((item) => this.readReasoningText(item)).join('')
    if (!value || !isObject(value)) return ''

    const record = value as Record<string, unknown>
    return (
      this.readReasoningText(record.text) ||
      this.readReasoningText(record.content) ||
      this.readReasoningText(record.summary) ||
      this.readReasoningText(record.delta)
    )
  }
}

const RawStreamText = AgentRawStreamTextExtractor

export { AgentRawStreamTextExtractor, RawStreamText }
