import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  type ContextPayloadStore,
  InMemoryContextPayloadStore,
} from '../src/agent/context/ContextPayloadStore'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { compileProviderSendRequest } from '../src/agent/context/ProviderSendRequest'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { hashUserMessageText } from '../src/agent/context/userMessageText'
import { UserTextPayloadPlanner } from '../src/agent/context/UserTextPayloadPlanner'

const SessionId = 'user-text-regressions'
const InlineChars = 48_000

async function compileUserMessage(
  message: ModelMessage,
  payloadStore: ContextPayloadStore = new InMemoryContextPayloadStore(),
  contextWindow = 1_000_000
) {
  const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
  const compiled = await compileProviderSendRequest(
    {
      sessionId: SessionId,
      model: 'gpt-test',
      systemPrompt: '',
      contextWindow,
      rawHistoryMessages: [message],
      phase: 'stream',
      payloadStore,
    },
    new ProviderRequestCompiler(registry)
  )
  const user = compiled.messages.find((entry) => entry.role === 'user')!
  assert.equal(user.role, 'user')
  assert.ok(Array.isArray(user.content))
  return {
    compiled,
    user: { ...user, content: user.content },
    record: registry.peek(SessionId)!.ledger.list()[0]!,
    residency: registry.peek(SessionId)!.ledger.residencyOf(registry.peek(SessionId)!.ledger.list()[0]!.id),
  }
}

describe('user text admission and persistence', () => {
  test('a large image leaves a short instruction unchanged and creates no text payload', async () => {
    const image = { type: 'image' as const, image: `data:image/png;base64,${'A'.repeat(100_000)}` }
    const { compiled, user, record } = await compileUserMessage({
      role: 'user',
      content: [{ type: 'text', text: '描述这张图' }, image],
    })

    assert.deepEqual(user.content, [{ type: 'text', text: '描述这张图' }, image])
    assert.equal(record.admittedResidency, 'INLINE')
    assert.equal(record.excerpt, null)
    assert.equal(compiled.userTextPayloadRefs, 0)
  })

  test('image-only input remains intact instead of receiving an empty text excerpt', async () => {
    const image = { type: 'image' as const, image: `data:image/png;base64,${'A'.repeat(100_000)}` }
    const { compiled, user, record } = await compileUserMessage({ role: 'user', content: [image] })

    assert.deepEqual(user.content, [image])
    assert.equal(record.admittedResidency, 'INLINE')
    assert.equal(compiled.userTextPayloadRefs, 0)
  })

  test('capacity overflow uses one bounded excerpt to replace all text parts and keeps attachments in order', async () => {
    const first = '开头约束必须保留'
    const last = `${'中'.repeat(100_000)}结尾约束必须保留`
    const image = { type: 'image' as const, image: 'https://example.com/image.png' }
    const file = {
      type: 'file' as const,
      data: 'https://example.com/manual.pdf',
      mediaType: 'application/pdf',
    }
    const fullText = `${first}\n${last}`
    const payloadStore = new InMemoryContextPayloadStore()
    const { compiled, user, record, residency } = await compileUserMessage(
      {
        role: 'user',
        content: [{ type: 'text', text: first }, image, { type: 'text', text: last }, file],
      },
      payloadStore,
      50_000
    )
    const textParts = user.content.filter((part) => part.type === 'text')

    assert.equal(textParts.length, 1)
    assert.ok(textParts[0]!.text.length <= InlineChars)
    assert.ok(textParts[0]!.text.includes(first))
    assert.ok(textParts[0]!.text.includes('结尾约束必须保留'))
    assert.deepEqual(
      user.content.filter((part) => part.type !== 'text'),
      [image, file]
    )
    assert.equal(record.admittedResidency, 'INLINE')
    assert.equal(residency, 'EXCERPT')
    assert.equal(record.excerpt?.refKind, 'payload-ref')
    assert.equal(compiled.userTextPayloadRefs, 1)
    const stored = await payloadStore.findUserTextByHash(SessionId, hashUserMessageText(fullText))
    assert.equal(stored?.text, fullText)
    assert.equal(record.payloadRef, stored?.payloadRef)
    assert.ok(textParts[0]!.text.includes(stored!.payloadRef))
  })

  test('long multimodal text keeps its durable reference when a governance registry is recreated', async () => {
    const fullText = `开始${'文'.repeat(60_000)}结束`
    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: fullText },
        { type: 'image', image: 'https://example.com/image.png' },
      ],
    }
    const payloadStore = new InMemoryContextPayloadStore()
    const first = await compileUserMessage(message, payloadStore)
    const restored = await compileUserMessage(message, payloadStore)
    const payload = await payloadStore.findUserTextByHash(SessionId, hashUserMessageText(fullText))

    assert.ok(payload)
    assert.equal(payload.text, fullText)
    assert.equal(first.record.payloadRef, payload.payloadRef)
    assert.equal(restored.record.payloadRef, payload.payloadRef)
    assert.equal(restored.record.excerpt?.refKind, 'payload-ref')
  })
})

describe('user text payload lookup batches', () => {
  test('deduplicates hashes, batches lookup and writes, and does not rewrite existing text', async () => {
    const backing = new InMemoryContextPayloadStore()
    const calls: string[] = []
    const store: ContextPayloadStore = {
      findByHash: async () => {
        throw new Error('single generic lookup')
      },
      findUserTextByHash: async () => {
        throw new Error('single user lookup')
      },
      findManyByHash: async (sessionId, hashes) => {
        calls.push(`generic:${hashes.length}`)
        return backing.findManyByHash(sessionId, hashes)
      },
      findUserTextsByHash: async (sessionId, hashes) => {
        calls.push(`user:${hashes.length}`)
        return backing.findUserTextsByHash(sessionId, hashes)
      },
      put: (record) => backing.put(record),
      putUserTextMany: async (records) => {
        calls.push(`write:${records.length}`)
        return backing.putUserTextMany(records)
      },
      listForSession: (sessionId) => backing.listForSession(sessionId),
    }
    const planner = new UserTextPayloadPlanner(store)
    const messages: ModelMessage[] = ['a', 'b', 'a', 'b'].map((letter) => ({
      role: 'user',
      content: letter.repeat(50_000),
    }))
    const input = { sessionId: SessionId, messages, thresholdChars: InlineChars }
    const first = await planner.persistOversizedUserTexts(input)
    assert.deepEqual(calls, ['user:2', 'generic:2', 'write:2'])
    assert.equal(first.references.length, 4)
    assert.equal(first.references[0]!.payloadRef, first.references[2]!.payloadRef)
    calls.length = 0
    assert.deepEqual(await planner.persistOversizedUserTexts(input), first)
    assert.deepEqual(calls, ['user:2'])
    calls.length = 0
    await planner.persistOversizedUserTexts({
      ...input,
      messages: [{ role: 'user', content: '短消息' }],
    })
    assert.deepEqual(calls, [])
  })

  test('stores exposing only generic payload methods retain full text and stable references', async () => {
    const backing = new InMemoryContextPayloadStore()
    const store: ContextPayloadStore = {
      findByHash: (sessionId, hash) => backing.findByHash(sessionId, hash),
      findManyByHash: (sessionId, hashes) => backing.findManyByHash(sessionId, hashes),
      put: (record) => backing.put(record),
      putMany: (records) => backing.putMany(records),
      listForSession: (sessionId) => backing.listForSession(sessionId),
    }
    const fullText = '正文'.repeat(30_000)
    const planner = new UserTextPayloadPlanner(store)
    const input = {
      sessionId: SessionId,
      messages: [{ role: 'user' as const, content: fullText }],
      thresholdChars: InlineChars,
    }
    const first = await planner.persistOversizedUserTexts(input)
    assert.deepEqual(await planner.persistOversizedUserTexts(input), first)
    assert.equal(
      (await backing.findByHash(SessionId, first.references[0]!.hash))?.serializedResult,
      fullText
    )
  })
})

describe('multimodal governance measurement', () => {
  test('large attachment bytes remain intact while governance measures the shared attachment summary', async () => {
    const image = { type: 'image' as const, image: `data:image/png;base64,${'A'.repeat(400_000)}` }
    const { compiled, record, user } = await compileUserMessage({ role: 'user', content: [
      { type: 'text', text: 'Inspect the image' }, image,
    ] })
    assert.ok(record.bytes.full > 400_000)
    assert.ok(record.bytes.budget! < 300)
    assert.equal(compiled.estimate.mediaTokenCoverage, 'unknown')
    assert.equal(compiled.estimate.mediaPartCount, 1)
    assert.ok(compiled.estimate.estimatedChars < 10_000)
    assert.deepEqual(user.content[1], image)
    assert.equal(compiled.decision.okToSend, true)
  })
})
