import {
  isArray,
  isNull,
  isObject,
  isPlainObject,
  isString,
} from '@velaros-ai/core'

/**
 * 从一条 provider raw 分片里抢救思考文本：先认 Anthropic 与 Responses 的专有形状，
 * 再退回 choices[].delta 上的各种 reasoning 别名；认不出来返回空串。
 */
function extractReasoningDeltaFromRawChunk(rawValue: unknown): string {
  if (!rawValue || !isPlainObject(rawValue)) return ''

  const record = rawValue
  const anthropicReasoningText = extractAnthropicReasoningText(record)
  if (anthropicReasoningText) return anthropicReasoningText

  const responseReasoningText = extractResponsesReasoningText(record)
  if (responseReasoningText) return responseReasoningText

  const choices = record.choices
  if (!isArray(choices)) return ''

  return choices
    .map((choice) => {
      if (!choice || !isObject(choice)) return ''

      const delta = (choice as { delta?: unknown }).delta
      if (!delta || !isPlainObject(delta)) return ''

      const deltaRecord = delta
      return (
        readReasoningText(deltaRecord.reasoning_content) ||
        readReasoningText(deltaRecord.reasoningContent) ||
        readReasoningText(deltaRecord.reasoning) ||
        readReasoningText(deltaRecord.thinking) ||
        readReasoningText(deltaRecord.thought) ||
        readReasoningText(deltaRecord.thoughts) ||
        readReasoningText(deltaRecord.reasoning_details) ||
        readReasoningText(deltaRecord.reasoningDetails)
      )
    })
    .join('')
}

/**
 * 从一条 provider raw 分片里抢救可见正文：先认 Anthropic 与 Responses 的专有形状，
 * 再退回 choices[] 上的 delta 与 message；认不出来返回空串。
 */
function extractVisibleTextFromRawChunk(rawValue: unknown): string {
  if (!rawValue || !isPlainObject(rawValue)) return ''

  const record = rawValue
  const anthropicText = extractAnthropicVisibleText(record)
  if (anthropicText) return anthropicText

  const responseText = extractResponsesVisibleText(record)
  if (responseText) return responseText

  const choices = record.choices
  if (!isArray(choices)) return ''

  return choices
    .map((choice) => {
      if (!choice || !isPlainObject(choice)) return ''

      const choiceRecord = choice
      return [
        extractChoiceVisibleText(choiceRecord.delta),
        extractChoiceVisibleText(choiceRecord.message),
      ].join('')
    })
    .join('')
}

/** Responses 协议分片里的思考文本：只认 reasoning summary 的增量，以及收尾的 reasoning item。 */
function extractResponsesReasoningText(record: Record<string, unknown>): string {
  switch (record.type) {
    case 'response.reasoning_summary_text.delta':
      return readReasoningText(record.delta)
    case 'response.output_item.done':
      return extractResponseReasoningItemText(record.item)
    default:
      return ''
  }
}

/** Anthropic 协议分片里的思考文本：只认 thinking_delta 与 thinking / redacted_thinking 内容块。 */
function extractAnthropicReasoningText(record: Record<string, unknown>): string {
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
      readReasoningText(delta?.thinking) ||
      readReasoningText(delta?.thought) ||
      readReasoningText(delta?.text)
    )

  if (contentBlockType === 'thinking' || contentBlockType === 'redacted_thinking')
    return (
      readReasoningText(contentBlock?.thinking) ||
      readReasoningText(contentBlock?.text)
    )

  return ''
}

/** Responses 收尾 item 里的思考文本：只有 type=reasoning 的 item 才算数。 */
function extractResponseReasoningItemText(item: unknown): string {
  if (!item || !isPlainObject(item)) return ''

  const record = item
  return record.type === 'reasoning' ? readReasoningText(record.summary) : ''
}

/** Responses 协议分片里的可见正文：认正文增量、拒答增量，以及收尾的 message item。 */
function extractResponsesVisibleText(record: Record<string, unknown>): string {
  switch (record.type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return readVisibleText(record.delta)
    case 'response.output_item.done':
      return extractResponseOutputItemText(record.item)
    default:
      return ''
  }
}

/** Anthropic 协议分片里的可见正文：认 text_delta、text 内容块与 message_start 里的整段内容。 */
function extractAnthropicVisibleText(record: Record<string, unknown>): string {
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
        ? readVisibleText(delta?.text)
        : ''
    case 'content_block_start':
      return contentBlockType === 'text' || isNull(contentBlockType)
        ? readVisibleText(contentBlock?.text)
        : ''
    default:
      return readVisibleText(message?.content)
  }
}

/** Responses 收尾 item 里的可见正文：只有 type=message 的 item 才算数。 */
function extractResponseOutputItemText(item: unknown): string {
  if (!item || !isPlainObject(item)) return ''

  const record = item
  return record.type === 'message' ? readVisibleText(record.content) : ''
}

/** 一个 choice 的 delta 或 message 里的可见正文：拒答文案与正文都算，按顺序拼起来。 */
function extractChoiceVisibleText(value: unknown): string {
  if (!value || !isPlainObject(value)) return ''

  const record = value
  return [readVisibleText(record.refusal), readVisibleText(record.content)].join('')
}

/** 把任意形状递归投影成可见正文：字符串直接取，数组逐项拼，对象试 text 再试 content。 */
function readVisibleText(value: unknown): string {
  if (isString(value)) return value
  if (isArray(value)) return value.map((item) => readVisibleText(item)).join('')
  if (!value || !isPlainObject(value)) return ''

  const record = value
  return readVisibleText(record.text) || readVisibleText(record.content)
}

/** 把任意形状递归投影成思考文本：字符串直接取，数组逐项拼，对象依次试 text/content/summary/delta。 */
function readReasoningText(value: unknown): string {
  if (isString(value)) return value
  if (isArray(value)) return value.map((item) => readReasoningText(item)).join('')
  if (!value || !isPlainObject(value)) return ''

  const record = value
  return (
    readReasoningText(record.text) ||
    readReasoningText(record.content) ||
    readReasoningText(record.summary) ||
    readReasoningText(record.delta)
  )
}

export { extractReasoningDeltaFromRawChunk, extractVisibleTextFromRawChunk }
