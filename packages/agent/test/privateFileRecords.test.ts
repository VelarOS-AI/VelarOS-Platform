import { expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import { ContextRetrievalIndexBuilder } from '../src/agent/context/retrieval/IndexBuilder'
import { contextRetrievalTools } from '../src/tool-library/builtin/ContextRetrieval.tool'

test('generic recall cannot expose guessed internal source payloads', async () => {
  const store = new InMemoryContextPayloadStore()
  const hash = 'a'.repeat(64)
  await store.put({ sessionId: 's', hash, payloadRef: `ctx-payload:s:${hash}`, toolCallId: `source:${hash}`, toolName: '__project_file_reference__', serializedResult: JSON.stringify({ content: 'private full source' }), chars: 50, createdAt: 1 })
  const recall = contextRetrievalTools['context:recall']!
  for (const ref of [`source:${hash}`, `view:${hash}`, `read-page:${hash}`, `ctx-payload:s:${hash}`]) {
    for (const refKind of [undefined, 'tool-payload', 'payload-ref'] as const) {
      const result = await recall.execute({ ref, refKind }, { sessionId: 's', contextPayloadStore: store } as never) as any
      expect(result.found).toBe(false)
      expect(JSON.stringify(result)).not.toContain('private full source')
    }
  }
})

test('private file snapshots and reference records are excluded from conversation search', async () => {
  const hidden = (name: string) => ({ toolName: name, serializedResult: 'secret source', toolCallId: name })
  const builder = new ContextRetrievalIndexBuilder({
    loadSessionPayloads: async () => ({ userMessages: {}, toolResults: {
      one: hidden('__file_snapshot__'), two: hidden('__project_file_reference__'),
      three: { toolName: 'project:read', serializedResult: 'visible source', toolCallId: 'read-1' },
    } }),
  } as never, { loadSessionMessages: async () => [] } as never)
  const index = await builder.build('s')
  expect(index.toolPayloads).toHaveLength(1)
  expect(index.toolPayloads[0]!.toolCallId).toBe('read-1')
  expect(JSON.stringify(index)).not.toContain('secret source')
})
