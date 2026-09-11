import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createConversationScrollPositionStore } from '../../packages/ui/src/conversation/shell/conversationScrollPositionStore'

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  let writes = 0
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1
        values.set(key, value)
      },
    },
    read: (key: string) => values.get(key),
    writes: () => writes,
  }
}

void describe('conversation scroll position store', () => {
  void test('many saves while following the stream become one write', () => {
    const memory = createMemoryStorage()
    const store = createConversationScrollPositionStore({
      storageKey: 'positions',
      storage: () => memory.storage,
      flushDelayMs: 60_000,
    })

    for (let scrollTop = 0; scrollTop < 500; scrollTop += 5) store.save('session-a', scrollTop)
    assert.equal(memory.writes(), 0, 'no synchronous write per scroll event')
    assert.equal(store.read('session-a'), 495, 'reads come from memory right away')

    store.flush()
    assert.equal(memory.writes(), 1)
    assert.deepEqual(Object.keys(JSON.parse(memory.read('positions')!)), ['session-a'])
    store.flush()
    assert.equal(memory.writes(), 1, 'nothing pending, nothing written')
  })

  void test('reads the older format that carried a version field', () => {
    const memory = createMemoryStorage({
      positions: JSON.stringify({ old: { version: 1, scrollTop: 321.7, updatedAt: 5 } }),
    })
    const store = createConversationScrollPositionStore({
      storageKey: 'positions',
      storage: () => memory.storage,
    })

    assert.equal(store.read('old'), 321)
    assert.equal(store.read('missing'), null)
  })

  void test('keeps only the most recently used sessions', () => {
    const memory = createMemoryStorage()
    let clock = 0
    const store = createConversationScrollPositionStore({
      storageKey: 'positions',
      storage: () => memory.storage,
      maxSessions: 2,
      now: () => (clock += 1),
    })

    store.save('first', 1)
    store.save('second', 2)
    store.save('third', 3)
    store.flush()

    assert.deepEqual(Object.keys(JSON.parse(memory.read('positions')!)).sort(), ['second', 'third'])
    assert.equal(store.read('first'), null)
  })
})
