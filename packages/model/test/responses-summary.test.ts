import { createOpenAI } from '@ai-sdk/openai'
import { expect, test } from 'bun:test'

import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import { createAiSdkModelDriver } from '../src/index.js'

const request: ModelTurnRequest = {
  instructions: 'summary transport fixture',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}

async function collect(summaries: readonly string[][]) {
  const chunks: unknown[] = [
    { type: 'response.created', response: { id: 'resp_summary', created_at: 1, model: 'fixture' } },
  ]
  for (const [index, parts] of summaries.entries()) {
    const id = `rs_${index}`
    const text = parts.join('')
    const item = { type: 'reasoning', id, summary: [] }
    chunks.push({ type: 'response.output_item.added', output_index: index, item })
    for (const delta of parts)
      chunks.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: id,
        summary_index: 0,
        delta,
      })
    chunks.push({
      type: 'response.output_item.done',
      output_index: index,
      item: { ...item, summary: [{ type: 'summary_text', text }] },
    })
  }
  chunks.push(
    {
      type: 'response.output_item.added',
      output_index: summaries.length,
      item: { type: 'message', id: 'msg_summary' },
    },
    { type: 'response.output_text.delta', item_id: 'msg_summary', delta: 'Public answer.' },
    { type: 'response.completed', response: { usage: { input_tokens: 19, output_tokens: 7 } } }
  )
  const encoded = new TextEncoder().encode(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  )
  const model = createOpenAI({
    apiKey: 'fixture-only',
    fetch: async () => new Response(encoded, { headers: { 'content-type': 'text/event-stream' } }),
  })('fixture')
  const driver = createAiSdkModelDriver({
    id: 'openai/fixture',
    model,
    limits: { contextTokens: 32000, inputTokens: 30000, outputTokens: 1000 },
  })
  const events: ModelTurnDelta[] = []
  for await (const event of driver.stream(request, new AbortController().signal)) events.push(event)
  return events
}

test('Responses summaries preserve split headings, body paragraphs and subsequent summaries separately from the public answer', async () => {
  const summaries = [
    [
      '**Inspect',
      'ing files**',
      '\n\nThe response supplies a body paragraph.',
      '\nA second body line.',
    ],
    ['**Checking results**\n\n', 'The verification summary is retained.'],
  ]
  const events = await collect(summaries)
  expect(
    events
      .filter((event) => event.type === 'reasoning')
      .map((event) => event.text)
      .join('')
  ).toBe(summaries.map((parts) => parts.join('')).join('\n\n'))
  expect(events.filter((event) => event.type === 'text')).toEqual([
    { type: 'text', text: 'Public answer.' },
  ])
  expect(events.some((event) => event.type === 'error')).toBe(false)
})

test('a heading-only provider summary remains heading-only without adding an invented body', async () => {
  const events = await collect([['**Checking files**']])
  expect(
    events
      .filter((event) => event.type === 'reasoning')
      .map((event) => event.text)
      .join('')
  ).toBe('**Checking files**')
  expect(events.some((event) => event.type === 'error')).toBe(false)
})
