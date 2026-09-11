import assert from 'node:assert/strict'

import type { TextStreamPart, ToolSet } from 'ai'
import { describe, test } from 'bun:test'

import { type InterruptedStreamPartial, StreamConsumer } from '../src/agent/stream'

type StreamPart = TextStreamPart<ToolSet>
type AssistantContent = Awaited<ReturnType<StreamConsumer['consumeAssistantStream']>>

/** 一次流消费里宿主收到的东西。 */
interface StreamProbe {
  reasoning: Array<{ id: string; text: string }>
  text: string
  /** 取分片与发思考的先后：`pull:<分片类型>` / `reasoning:<id>:<文本>`。 */
  trace: string[]
  interrupted: Nullable<InterruptedStreamPartial>
}

const raw = (rawValue: unknown): StreamPart => ({ type: 'raw', rawValue }) as StreamPart
const part = (value: Record<string, unknown>): StreamPart => value as StreamPart
const chatChunk = (delta: Record<string, unknown>): StreamPart =>
  raw({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })
const finishParts: StreamPart[] = [
  part({ type: 'finish-step', finishReason: 'stop', rawFinishReason: 'stop', usage: {}, response: {} }),
  part({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} }),
]

function createProbe(): StreamProbe {
  return { reasoning: [], text: '', trace: [], interrupted: null }
}

function consumeInto(probe: StreamProbe, parts: StreamPart[], failure?: Error): Promise<AssistantContent> {
  const stream: AsyncIterable<StreamPart> = {
    async *[Symbol.asyncIterator]() {
      for (const next of parts) {
        probe.trace.push(`pull:${next.type}`)
        yield next
      }
      if (failure) throw failure
    },
  }
  return new StreamConsumer({} as never).consumeAssistantStream(
    stream,
    { turn: 1, hasToolUse: false, accumulatedText: '', hasVisibleOutput: false },
    {
      abortSignal: new AbortController().signal,
      executor: { enqueue: () => undefined },
      events: {
        emitReasoningDelta: (payload) => {
          probe.reasoning.push(payload)
          probe.trace.push(`reasoning:${payload.id}:${payload.text}`)
        },
        emitTextDelta: (delta) => {
          probe.text += delta
        },
        emitGeneratedFile: () => undefined,
        emitSource: () => undefined,
        emitToolStart: () => undefined,
      },
      model: 'probe-model',
      onInterruptedPartial: (partial) => {
        probe.interrupted = partial
      },
    }
  )
}

async function consume(parts: StreamPart[]): Promise<StreamProbe & { assistantContent: AssistantContent }> {
  const probe = createProbe()
  const assistantContent = await consumeInto(probe, parts)
  return { ...probe, assistantContent }
}

function joinReasoning(content: AssistantContent): string {
  return content.map((entry) => (entry.type === 'reasoning' ? entry.text : '')).join('')
}

function emittedReasoning(probe: StreamProbe): string {
  return probe.reasoning.map((delta) => delta.text).join('')
}

function reasoningIds(probe: StreamProbe): string[] {
  return [...new Set(probe.reasoning.map((delta) => delta.id))]
}

/** `@ai-sdk/anthropic` 的真实顺序：每个 SSE 分片先发 raw，再发解析出的部分。 */
function anthropicStream(thinking: readonly string[], answer: string): StreamPart[] {
  return [
    raw({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }),
    raw({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    part({ type: 'reasoning-start', id: '0' }),
    ...thinking.flatMap((delta) => [
      raw({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: delta } }),
      part({ type: 'reasoning-delta', id: '0', text: delta }),
    ]),
    raw({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    part({ type: 'reasoning-delta', id: '0', text: '', providerMetadata: { anthropic: { signature: 'sig' } } }),
    raw({ type: 'content_block_stop', index: 0 }),
    part({ type: 'reasoning-end', id: '0' }),
    raw({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    part({ type: 'text-start', id: '1' }),
    raw({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } }),
    part({ type: 'text-delta', id: '1', text: answer }),
    raw({ type: 'content_block_stop', index: 1 }),
    part({ type: 'text-end', id: '1' }),
    raw({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
    raw({ type: 'message_stop' }),
    ...finishParts,
  ]
}

void describe('stream reasoning has a single source', () => {
  void test('Anthropic thinking is emitted once although every thinking_delta also arrives as a raw chunk', async () => {
    const thinking = ['The user wants a', ' ~1200 word article on rate limiting "wel', 'l",', ' in 5 sections.']
    const consumed = await consume(anthropicStream(thinking, 'Here is the article.'))

    assert.equal(emittedReasoning(consumed), thinking.join(''))
    assert.deepEqual(reasoningIds(consumed), ['0'], '只认结构化来源，不再以 raw 的 id 再发一遍')
    assert.equal(joinReasoning(consumed.assistantContent), thinking.join(''), '写回历史的也只有一份思考')
    assert.equal(consumed.text, 'Here is the article.')
  })

  void test('chat-completions reasoning that only lives in raw chunks still streams, exactly once', async () => {
    const reasoning = ['wel', 'l"', '12', '00', ' words']
    const consumed = await consume([
      chatChunk({ role: 'assistant', content: '' }),
      ...reasoning.map((reasoningContent) => chatChunk({ reasoning_content: reasoningContent })),
      chatChunk({ content: 'Done.' }),
      part({ type: 'text-start', id: 'txt-0' }),
      part({ type: 'text-delta', id: 'txt-0', text: 'Done.' }),
      part({ type: 'text-end', id: 'txt-0' }),
      ...finishParts,
    ])

    assert.equal(emittedReasoning(consumed), 'well"1200 words')
    assert.deepEqual(reasoningIds(consumed), ['deepseek-reasoning'])
    assert.equal(consumed.reasoning.length, reasoning.length, '逐分片发出，不攒到流尾')
    assert.ok(
      consumed.trace.indexOf('reasoning:deepseek-reasoning:wel') < consumed.trace.indexOf('pull:text-delta'),
      '兜底思考随流发出，不等正文'
    )
    assert.equal(joinReasoning(consumed.assistantContent), 'well"1200 words')
    assert.deepEqual(
      consumed.assistantContent.map((entry) => entry.type),
      ['reasoning', 'reasoning', 'reasoning', 'reasoning', 'reasoning', 'text']
    )
  })

  void test('an OpenAI Responses summary is not appended again by output_item.done', async () => {
    const summary = ['**Planning the answer**', '\n\nThe user wants "wel', 'l" and 1', '200 words.']
    const full = summary.join('')
    const consumed = await consume([
      raw({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } }),
      raw({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
      part({ type: 'reasoning-start', id: 'rs_1:0', providerMetadata: { openai: { itemId: 'rs_1' } } }),
      raw({
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
      ...summary.flatMap((delta) => [
        raw({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta }),
        part({ type: 'reasoning-delta', id: 'rs_1:0', text: delta }),
      ]),
      raw({
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs_1',
        summary_index: 0,
        part: { type: 'summary_text', text: full },
      }),
      raw({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: full }] },
      }),
      part({ type: 'reasoning-end', id: 'rs_1:0' }),
      raw({ type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', content: [] } }),
      part({ type: 'text-start', id: 'msg_1' }),
      raw({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Answer.' }),
      part({ type: 'text-delta', id: 'msg_1', text: 'Answer.' }),
      raw({
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'Answer.' }] },
      }),
      part({ type: 'text-end', id: 'msg_1' }),
      raw({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }),
      ...finishParts,
    ])

    assert.equal(emittedReasoning(consumed), full)
    assert.deepEqual(reasoningIds(consumed), ['rs_1:0'])
    assert.equal(joinReasoning(consumed.assistantContent), full)
    assert.equal(consumed.text, 'Answer.')
  })

  void test('a raw chunk parsed into reasoning-start on the same SSE chunk does not leak a first copy', async () => {
    // 形如 openai-compatible 的 provider：首个带 reasoning_content 的分片依次发 raw → reasoning-start → reasoning-delta。
    const reasoning = ['1', '1', '00 tokens']
    const consumed = await consume([
      chatChunk({ role: 'assistant', content: '' }),
      ...reasoning.flatMap((delta, index) => [
        chatChunk({ reasoning_content: delta }),
        ...(index === 0 ? [part({ type: 'reasoning-start', id: 'reasoning-0' })] : []),
        part({ type: 'reasoning-delta', id: 'reasoning-0', text: delta }),
      ]),
      part({ type: 'reasoning-end', id: 'reasoning-0' }),
      chatChunk({ content: 'Done.' }),
      part({ type: 'text-start', id: 'txt-0' }),
      part({ type: 'text-delta', id: 'txt-0', text: 'Done.' }),
      part({ type: 'text-end', id: 'txt-0' }),
      ...finishParts,
    ])

    assert.equal(emittedReasoning(consumed), '1100 tokens')
    assert.deepEqual(reasoningIds(consumed), ['reasoning-0'])
    assert.equal(joinReasoning(consumed.assistantContent), '1100 tokens')
  })

  void test('thinking packed whole into content_block_start still shows once when no thinking_delta follows', async () => {
    const consumed = await consume([
      raw({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }),
      raw({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'The whole thought, sent at once.', signature: '' },
      }),
      part({ type: 'reasoning-start', id: '0' }),
      raw({ type: 'content_block_stop', index: 0 }),
      part({ type: 'reasoning-end', id: '0' }),
      raw({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      part({ type: 'text-start', id: '1' }),
      raw({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } }),
      part({ type: 'text-delta', id: '1', text: 'Answer.' }),
      part({ type: 'text-end', id: '1' }),
      ...finishParts,
    ])

    assert.equal(emittedReasoning(consumed), 'The whole thought, sent at once.')
    assert.deepEqual(reasoningIds(consumed), ['deepseek-reasoning'])
    assert.deepEqual(
      consumed.assistantContent.map((entry) => entry.type),
      ['reasoning', 'text']
    )
  })

  void test('a Responses summary reported only by output_item.done still shows once', async () => {
    const summary = '**Checking the numbers** 1200 is "well" within budget.'
    const consumed = await consume([
      raw({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
      part({ type: 'reasoning-start', id: 'rs_1:0' }),
      raw({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: summary }] },
      }),
      part({ type: 'reasoning-end', id: 'rs_1:0' }),
      raw({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Answer.' }),
      part({ type: 'text-delta', id: 'msg_1', text: 'Answer.' }),
      ...finishParts,
    ])

    assert.equal(emittedReasoning(consumed), summary)
    assert.equal(joinReasoning(consumed.assistantContent), summary)
  })

  void test('a stream that dies right after a raw reasoning chunk still delivers that reasoning', async () => {
    const probe = createProbe()
    await assert.rejects(
      consumeInto(probe, [chatChunk({ reasoning_content: 'half a thought' })], new Error('socket hang up')),
      /socket hang up/
    )

    assert.deepEqual(probe.reasoning, [{ id: 'deepseek-reasoning', text: 'half a thought' }])
    assert.equal(joinReasoning(probe.interrupted?.assistantContent ?? []), 'half a thought')
  })
})
