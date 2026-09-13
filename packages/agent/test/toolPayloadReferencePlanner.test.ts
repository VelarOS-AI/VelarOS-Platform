import type { ModelMessage } from 'ai'
import { expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import {
  buildToolPayloadRefOccurrenceKey,
  buildToolPayloadRefsForProviderMessages,
} from '../src/agent/context/ToolPayloadReferencePlanner'

function message(value: string, toolCallId = 'read-1'): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'project:read',
        output: { type: 'text', value },
      },
    ],
  }
}

test('repeated provider planning reuses a paged result instead of archiving its envelope', async () => {
  const store = new InMemoryContextPayloadStore()
  const original = JSON.stringify({ content: '原文😀\\路径\r\n'.repeat(1200) })
  const first = await buildToolPayloadRefsForProviderMessages({
    sessionId: 'session',
    messages: [message(original)],
    store,
  })
  const paged = JSON.stringify({
    v: 1,
    __contextRef: 'tool-output',
    ref: first['read-1'],
    excerpt: '原文预览',
    originalLength: original.length,
  })
  for (let i = 0; i < 3; i++) {
    const next = await buildToolPayloadRefsForProviderMessages({
      sessionId: 'session',
      messages: [message(paged)],
      store,
    })
    expect(next).toEqual(first)
  }
  const stored = await store.listForSession('session')
  expect(stored).toHaveLength(1)
  expect(stored[0]!.serializedResult).toBe(original)
})

test('mixed raw and existing references retain occurrence identity without ambiguous call aliases', async () => {
  const store = new InMemoryContextPayloadStore()
  const existingRef = 'ctx-payload:session:existing'
  const wrapped = JSON.stringify({ __contextRef: 'tool-output', ref: existingRef })
  const refs = await buildToolPayloadRefsForProviderMessages({
    sessionId: 'session',
    messages: [message(wrapped), message('different raw output')],
    store,
  })
  expect(refs[buildToolPayloadRefOccurrenceKey(0, 0)]).toBe(existingRef)
  expect(refs[buildToolPayloadRefOccurrenceKey(1, 0)]).not.toBe(existingRef)
  expect(refs['read-1']).toBeUndefined()
  expect(await store.listForSession('session')).toHaveLength(1)
})

test('malformed reference-looking text remains available as original content', async () => {
  const store = new InMemoryContextPayloadStore()
  const value = '{"__contextRef":"tool-output","ref":"ctx-payload:unfinished'
  await buildToolPayloadRefsForProviderMessages({
    sessionId: 'session',
    messages: [message(value)],
    store,
  })
  expect((await store.listForSession('session'))[0]!.serializedResult).toBe(value)
})
