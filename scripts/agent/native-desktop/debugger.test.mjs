// 用途：验证大轨迹、Unicode、传输截断与断开连接；失败保留，辅助截图不阻断官方判分。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

import { connectDebugger, readDebuggerSnapshot } from './debugger.mjs'
import { capturePreview, comparisonEligible, finishStatus } from './controller.mjs'

function snapshot(text, transform = (value) => value) {
  const key = '__snapshot'
  const context = createContext({ [key]: text })
  const expressions = []
  const metadata = { chars: text.length, sha256: createHash('sha256').update(text).digest('hex') }
  const wire = {
    async evaluate(expression) {
      expressions.push(expression)
      if (expression === 'bootstrap') return metadata
      const value = runInContext(expression, context)
      return expression.includes('.slice(') ? transform(value) : value
    },
  }
  return { key, context, expressions, metadata, wire }
}

test('bounded chunks preserve a large snapshot including surrogate boundaries and escaped source', async () => {
  const value = {
    source: 'x'.repeat(256 * 1024 - 12) + '😀中文\r\n\t"\\'.repeat(60000),
    nested: { text: 'return "a\\\\b";' },
  }
  const fixture = snapshot(JSON.stringify(value))
  assert.deepEqual(await readDebuggerSnapshot(fixture.wire, 'bootstrap', fixture.key), value)
  assert(fixture.expressions.filter((x) => x.includes('.slice(')).length > 2)
  assert.equal(fixture.context[fixture.key], undefined)
})

test('truncation, corruption and invalid lengths fail closed and release the browser snapshot', async () => {
  for (const transform of [(chunk) => chunk.slice(1), (chunk) => chunk.replace('a', 'b')]) {
    const fixture = snapshot(JSON.stringify({ text: 'a'.repeat(300000) }), transform)
    await assert.rejects(
      readDebuggerSnapshot(fixture.wire, 'bootstrap', fixture.key),
      /Incomplete|hash mismatch/
    )
    assert.equal(fixture.context[fixture.key], undefined)
  }
  const fixture = snapshot('{"text":"safe"}')
  fixture.metadata.chars = 129 * 1024 * 1024
  await assert.rejects(readDebuggerSnapshot(fixture.wire, 'bootstrap', fixture.key), /metadata/)
  assert.equal(
    fixture.expressions.some((x) => x.includes('.slice(')),
    false
  )
  assert.equal(fixture.context[fixture.key], undefined)
})

test('snapshot cleanup failures retain the original transport error', async () => {
  const wire = {
    async evaluate(expression) {
      throw new Error(
        expression === 'bootstrap' ? 'transport disconnected' : 'cleanup disconnected'
      )
    },
  }
  await assert.rejects(readDebuggerSnapshot(wire, 'bootstrap', '__snapshot'), (error) => {
    assert(error instanceof AggregateError)
    assert.deepEqual(
      error.errors.map((e) => e.message),
      ['transport disconnected', 'cleanup disconnected']
    )
    return true
  })
})

const event = (name, values) => Object.assign(new Event(name), values)

class FakeSocket extends EventTarget {
  static instances = []
  readyState = 0
  sent = []
  constructor() {
    super()
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(event('close', { code: 1006, reason: 'transport dropped' }))
  }
}

const fetchFn = async () => ({
  json: async () => [
    { type: 'page', url: 'http://localhost/#/chat', webSocketDebuggerUrl: 'ws://localhost/debug' },
  ],
})

test('closed debugger connections reject pending and later calls without a command timeout', async () => {
  const wire = await connectDebugger('http://localhost', { fetchFn, WebSocketClass: FakeSocket })
  const socket = FakeSocket.instances.at(-1)
  const pending = wire.evaluate('1')
  socket.close()
  await assert.rejects(pending, /1006 transport dropped/)
  await assert.rejects(wire.evaluate('2'), /1006 transport dropped/)
  assert.equal(socket.sent.length, 1)
})

test('malformed debugger messages are reported instead of escaping the event handler', async () => {
  const wire = await connectDebugger('http://localhost', { fetchFn, WebSocketClass: FakeSocket })
  const socket = FakeSocket.instances.at(-1)
  const pending = wire.evaluate('1')
  socket.dispatchEvent(event('message', { data: 'truncated json' }))
  await assert.rejects(pending, /Malformed/)
  assert.equal(socket.readyState, 3)
})

test('opening failures are bounded and close the owned socket', async () => {
  class SilentSocket extends FakeSocket {
    constructor() {
      super()
      queueMicrotask(() => {
        this.readyState = 0
      })
    }
    dispatchEvent(value) {
      return value.type === 'open' ? true : super.dispatchEvent(value)
    }
  }
  await assert.rejects(
    connectDebugger('http://localhost', {
      fetchFn,
      WebSocketClass: SilentSocket,
      openTimeoutMs: 10,
    }),
    /connection timed out/
  )
  assert.equal(FakeSocket.instances.at(-1).readyState, 3)
})

test('failed auxiliary screenshots retain the error and permit official results; missing traces block comparison', async () => {
  const screenshot = await capturePreview(
    {
      capture: async () => {
        throw new Error('capture timeout')
      },
    },
    '/tmp/unused.png'
  )
  assert.equal(screenshot.status, 'failed')
  assert.match(screenshot.error, /capture timeout/)
  const participant = {
    grade: { status: 'graded', resolved: true },
    policyAudit: { confirmedSolutionPatchAccess: false, requiresReview: false },
  }
  const state = {
    screenshot,
    contextPolicy: { inputWindowTokens: 200000 },
    participants: {
      scriptact: { ...participant, metrics: { fullTrace: true }, inputWindowVerified: true },
      codex: { ...participant, evidence: { status: 'complete' }, inputWindowTokens: 200000 },
    },
  }
  state.status = finishStatus(state, { authenticationBlocker: null })
  assert.equal(state.status, 'completed')
  assert.equal(comparisonEligible(state), true)
  state.participants.scriptact.evidenceError = 'trace unavailable'
  state.status = finishStatus(state, { authenticationBlocker: null })
  assert.equal(state.status, 'evidence_infrastructure_failure')
  assert.equal(comparisonEligible(state), false)
})
