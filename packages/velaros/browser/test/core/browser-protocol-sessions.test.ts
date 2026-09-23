// 用途：钉住模型那条 CDP 会话在运行时这一侧的账：第一次用到才连、同时来的只连一次；事件序号只增、按方法与域筛、
// 游标之后才交；缓冲只为守住内存、挤掉的记条数；被拦下没人放行的请求到点由宿主放行并记一条事件；通道断了下次重连。
import assert from 'node:assert/strict'

import { describe, setSystemTime, test } from 'bun:test'

import { BrowserProtocolLimits } from '../../contract/constants.js'
import type { BrowserProtocolChannel } from '../../contract/requires.js'
import { BrowserProtocolSessions } from '../../impl/session/BrowserProtocolSessions.js'

/** 一条假的通道：记下发出去的命令，能手动推事件、手动断开。 */
function createChannel() {
  const sent: Array<{ method: string; params: unknown; sessionId: Optional<string> }> = []
  const eventListeners = new Set<
    (method: string, params: unknown, sessionId: Optional<string>) => void
  >()
  const closeListeners = new Set<() => void>()
  let closed = 0
  const channel: BrowserProtocolChannel = {
    send: async (method, params, sessionId) => {
      sent.push({ method, params, sessionId })
      return { ok: method }
    },
    onEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close: async () => {
      closed += 1
    },
  }
  return {
    channel,
    sent,
    emit: (method: string, params: unknown, sessionId?: string) =>
      eventListeners.forEach((listener) => listener(method, params, sessionId)),
    drop: () => closeListeners.forEach((listener) => listener()),
    closedTimes: () => closed,
  }
}

void describe('模型的 CDP 会话', () => {
  void test('第一次用到才连，同时来的两次只连一次；命令原样转发', async () => {
    const sessions = new BrowserProtocolSessions()
    const fake = createChannel()
    let opened = 0
    const open = async () => {
      opened += 1
      return fake.channel
    }
    const [result] = await Promise.all([
      sessions.send('s1', open, { method: 'DOM.getDocument', params: { depth: 1 } }),
      sessions.read('s1', open, {}),
    ])
    assert.equal(opened, 1)
    assert.deepEqual(result, { ok: 'DOM.getDocument' })
    assert.deepEqual(fake.sent, [
      { method: 'DOM.getDocument', params: { depth: 1 }, sessionId: undefined },
    ])
    await sessions.dispose()
  })

  void test('事件序号只增，按完整方法名或域前缀筛，只交游标之后的', async () => {
    const sessions = new BrowserProtocolSessions()
    const fake = createChannel()
    const open = async () => fake.channel
    await sessions.read('s1', open, {})
    fake.emit('Network.requestWillBeSent', { requestId: 'r1' })
    fake.emit('Page.loadEventFired', {})
    fake.emit('Network.responseReceived', { requestId: 'r1' }, 'child-1')
    const all = await sessions.read('s1', open, {})
    assert.deepEqual(
      all.events.map((event) => event.method),
      ['Network.requestWillBeSent', 'Page.loadEventFired', 'Network.responseReceived']
    )
    assert.equal(all.last, all.events.at(-1)!.seq)
    assert.equal(all.events.at(-1)!.session, 'child-1')
    const network = await sessions.read('s1', open, { method: 'Network.' })
    assert.equal(network.events.length, 2)
    const after = await sessions.read('s1', open, {
      method: 'Network.responseReceived',
      after: all.events[0]!.seq,
    })
    assert.deepEqual(
      after.events.map((event) => event.params),
      [{ requestId: 'r1' }]
    )
    await sessions.dispose()
  })

  void test('缓冲满了挤掉最早的，挤掉的条数记在 dropped', async () => {
    const sessions = new BrowserProtocolSessions()
    const fake = createChannel()
    const open = async () => fake.channel
    await sessions.read('s1', open, {})
    for (let index = 0; index < BrowserProtocolLimits.bufferedEvents + 3; index += 1)
      fake.emit('Log.entryAdded', { index })
    const read = await sessions.read('s1', open, {})
    assert.equal(read.events.length, BrowserProtocolLimits.bufferedEvents)
    assert.equal(read.dropped, 3)
    assert.deepEqual(read.events[0]!.params, { index: 3 })
    await sessions.dispose()
  })

  void test('被拦下没人放行的请求到点由宿主放行，并记一条 Velar.requestAutoContinued；模型放行过的不管', async () => {
    const sessions = new BrowserProtocolSessions()
    const fake = createChannel()
    const open = async () => fake.channel
    await sessions.read('s1', open, {})
    fake.emit('Fetch.requestPaused', {
      requestId: 'kept',
      request: { url: 'https://example.test/api/a' },
    })
    fake.emit('Fetch.requestPaused', {
      requestId: 'released',
      request: { url: 'https://example.test/api/b' },
    })
    await sessions.send('s1', open, {
      method: 'Fetch.continueRequest',
      params: { requestId: 'released' },
    })
    setSystemTime(new Date(Date.now() + BrowserProtocolLimits.autoContinueMs + 1_000))
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_300))
    } finally {
      setSystemTime()
    }
    const continued = fake.sent
      .filter((command) => command.method === 'Fetch.continueRequest')
      .map((command) => (command.params as { requestId: string }).requestId)
    assert.deepEqual(continued, ['released', 'kept'])
    const note = (await sessions.read('s1', open, { method: 'Velar.requestAutoContinued' })).events
    assert.equal(note.length, 1)
    assert.equal(note[0]!.params.url, 'https://example.test/api/a')
    await sessions.dispose()
  })

  void test('通道自己断了就忘掉，下次用到重连；close 断开通道', async () => {
    const sessions = new BrowserProtocolSessions()
    const first = createChannel()
    const second = createChannel()
    const channels = [first.channel, second.channel]
    const open = async () => channels.shift()!
    await sessions.read('s1', open, {})
    first.drop()
    await sessions.send('s1', open, { method: 'Page.enable' })
    assert.deepEqual(
      second.sent.map((command) => command.method),
      ['Page.enable']
    )
    await sessions.close('s1')
    assert.equal(second.closedTimes(), 1)
    await sessions.dispose()
  })
})
