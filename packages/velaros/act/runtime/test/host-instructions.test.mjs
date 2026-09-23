import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done } from './support/model-turn.mjs'

const driver = (stream) => ({
  id: 'instructions-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
  stream,
})
async function fixture(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-instructions-'))
  const runtime = await createRuntime({
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    ...options,
  })
  t.after(async () => {
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, dataDir, session: await runtime.openSession('main') }
}

test('INV-43 trusted host instructions reach actual requests and traces; reopen uses current product settings', async (t) => {
  const frames = []
  const model = driver(async function* (request) {
    frames.push(request)
    yield* done(request)
  })
  const f = await fixture(t, { model, instructions: 'host-language-first' })
  const events = []
  for await (const event of f.session.submit('user-text-only')) events.push(event)
  assert.match(frames[0].instructions, /host-language-first/)
  assert.match(frames[0].instructions, /当前帧标记/)
  const turn = events.find((event) => event.type === 'turn')
  const trace = await f.session.trace(turn.turnId)
  assert.match(trace.request.body, /host-language-first/)
  await f.runtime.close()
  const reopened = await createRuntime({
    dataDir: f.dataDir,
    model,
    instructions: 'host-language-second',
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
  })
  try {
    const session = await reopened.openSession('main')
    for await (const event of session.submit('next user text')) assert.notEqual(event.type, 'error')
    assert.match(frames.at(-1).instructions, /host-language-second/)
    assert.doesNotMatch(frames.at(-1).instructions, /host-language-first/)
  } finally {
    await reopened.close()
  }
})

test('host instructions are budgeted before the provider is called', async (t) => {
  let calls = 0
  const estimates = []
  const model = {
    ...driver(async function* (request) {
      calls++
      yield* done(request)
    }),
    estimate: async (request) => {
      estimates.push(request.instructions)
      return {
        tokens: request.instructions.includes('large-host-setting') ? 200000 : 1000,
        precision: 'exact',
        basis: 'instruction-sensitive',
      }
    },
  }
  const f = await fixture(t, { model, instructions: 'large-host-setting' })
  const events = []
  for await (const event of f.session.submit('small user input')) events.push(event)
  assert.equal(calls, 0)
  assert(estimates.some((text) => text.includes('large-host-setting')))
  assert.equal(events.at(-1).status, 'context_blocked')
})

test('repair requests retain host instructions without accepting malformed responses', async (t) => {
  const frames = []
  const f = await fixture(t, {
    instructions: 'host-repair-setting',
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield { type: 'text', text: 'missing frame control' }
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  const events = []
  for await (const event of f.session.submit('answer')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert(events.some((event) => event.type === 'rejected'))
  assert(frames.length >= 2)
  assert(frames.every((frame) => frame.instructions.includes('host-repair-setting')))
})

test('invalid host instruction configuration is rejected before runtime activation', async () => {
  await assert.rejects(createRuntime({ instructions: { text: 'invalid' } }), /instructions/)
})
