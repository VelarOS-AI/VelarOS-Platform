import assert from 'node:assert/strict'
import test from 'node:test'

import { ScriptActBridge } from '../../../dist/act/bridge/contracts.js'
import {
  createExternalModelDriver,
  scriptActBridgeProtocol,
} from '../../../dist/act/bridge/index.js'

const request = {
  instructions: 'instructions',
  materials: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 100,
}
function driver(send, options = {}) {
  let sequence = 0
  return createExternalModelDriver({
    id: 'web',
    limits: { contextTokens: 10000, inputTokens: 9000, outputTokens: 1000 },
    createId: () => String(++sequence),
    send,
    cancel: async () => {},
    ...options,
  })
}

test('INV-1 取消后的回复与错误租约不能执行', async () => {
  let sent
  const model = driver(async (value) => {
    sent = value
  })
  const controller = new AbortController()
  const turn = Array.fromAsync(model.stream(request, controller.signal))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    model.deliver({
      type: 'finished',
      requestId: sent.requestId,
      lease: 'wrong',
      text: 'wrong',
      reason: 'stop',
      evidence: 'done',
    }),
    false
  )
  controller.abort()
  assert.equal(
    model.deliver({
      type: 'finished',
      requestId: sent.requestId,
      lease: sent.lease,
      text: 'late',
      reason: 'stop',
      evidence: 'done',
    }),
    false
  )
  await assert.rejects(turn)
})

test('INV-1 超时撤销请求并通知宿主，迟到回复不会恢复租约', async () => {
  let sent
  const cancelled = []
  const model = driver(
    async (value) => {
      sent = value
    },
    {
      timeoutMs: 5,
      cancel: async (...identity) => {
        cancelled.push(identity)
      },
    }
  )
  await assert.rejects(Array.fromAsync(model.stream(request, new AbortController().signal)), {
    name: 'TimeoutError',
  })
  assert.deepEqual(cancelled, [[sent.requestId, sent.lease]])
  assert.equal(
    model.deliver({
      type: 'finished',
      requestId: sent.requestId,
      lease: sent.lease,
      text: 'late',
      reason: 'stop',
      evidence: 'done',
    }),
    false
  )
  model.close()
})

test('INV-3 信封严格核对身份、可选字段和对象载荷，保留载荷内容', () => {
  const envelope = {
    service: ScriptActBridge.service,
    version: ScriptActBridge.version,
    id: 'message',
    type: 'request',
    hostId: 'host',
    epoch: 'epoch',
    replyTo: 'parent',
    payload: { value: null, items: [false, 0, { text: '原文' }] },
  }
  assert.deepEqual(scriptActBridgeProtocol.parse(envelope), envelope)
  const required = { ...envelope }
  for (const key of ['hostId', 'epoch', 'replyTo']) delete required[key]
  assert.deepEqual(scriptActBridgeProtocol.parse(required), required)
  for (const value of [
    null,
    [],
    'message',
    { ...envelope, service: 'other' },
    { ...envelope, version: 2 },
    { ...envelope, extra: true },
    { ...envelope, payload: [] },
    { ...envelope, payload: null },
    { ...envelope, payload: undefined },
    ...['id', 'type', 'hostId', 'epoch', 'replyTo'].flatMap((key) =>
      ['', 'x'.repeat(129), 1, null].map((value) => ({ ...envelope, [key]: value }))
    ),
    ...['id', 'type'].map((key) => ({ ...envelope, [key]: undefined })),
  ])
    assert.throws(() => scriptActBridgeProtocol.parse(value), { code: 'PROTOCOL' })
})

test('INV-2 原文完整交付且 JSON 经过正式合同核对', async () => {
  let model
  model = driver(async (value) => {
    assert.ok(value.prompt.includes('instructions'))
    queueMicrotask(() =>
      model.deliver({
        type: 'finished',
        requestId: value.requestId,
        lease: value.lease,
        text: 'raw\ntext',
        reason: 'stop',
        evidence: 'provider.done',
      })
    )
  })
  assert.deepEqual(await Array.fromAsync(model.stream(request, new AbortController().signal)), [
    { type: 'text', text: 'raw\ntext' },
    { type: 'finish', reason: 'stop' },
  ])
  model.close()
  await assert.rejects(Array.fromAsync(model.stream(request, new AbortController().signal)))
  model = driver(async (value) =>
    model.deliver({
      type: 'finished',
      requestId: value.requestId,
      lease: value.lease,
      text: '{"ok":"bad"}',
      reason: 'stop',
      evidence: 'provider.done',
    })
  )
  await assert.rejects(
    Array.fromAsync(
      model.stream(
        {
          ...request,
          response: {
            type: 'json',
            name: 'Result',
            description: 'result',
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
        new AbortController().signal
      )
    )
  )
})
