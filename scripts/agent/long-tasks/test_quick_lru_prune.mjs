import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import test from 'node:test'

const { default: QuickLRU } = await import(pathToFileURL(resolve('index.js')))
const clock = (t, start = 100) => {
  let value = start
  let reads = 0
  t.mock.method(Date, 'now', () => {
    reads++
    return value
  })
  return {
    set: (next) => {
      value = next
    },
    reads: () => reads,
    reset: () => {
      reads = 0
    },
  }
}
const prune = (cache) => {
  assert.equal(typeof cache.prune, 'function', 'prune is a public operation')
  return cache.prune()
}

test('empty, exact expiry, one time snapshot and repeated sweeps', (t) => {
  const now = clock(t)
  const cache = new QuickLRU({ maxSize: 10 })
  assert.equal(prune(cache), 0)
  cache.set('expired', 1, { maxAge: 5 }).set('live', 2, { maxAge: 6 }).set('forever', undefined)
  now.set(105)
  now.reset()
  assert.equal(prune(cache), 1)
  assert.equal(now.reads(), 1)
  assert.equal(prune(cache), 0)
  assert.deepEqual(
    [...cache.entriesAscending()],
    [
      ['live', 2],
      ['forever', undefined],
    ]
  )
  assert.equal(cache.expiresIn('live'), 1)
})

test('expiry zero, object keys, undefined values and unbounded age', (t) => {
  const now = clock(t, -5)
  const key = {}
  const value = {}
  const notifications = []
  const cache = new QuickLRU({ maxSize: 4, onEviction: (k, v) => notifications.push([k, v]) })
  cache.set(key, undefined, { maxAge: 5 }).set('keep', value, { maxAge: Infinity })
  now.set(0)
  assert.equal(prune(cache), 1)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0][0], key)
  assert.equal(notifications[0][1], undefined)
  assert.equal(cache.peek('keep'), value)
  assert.equal(cache.has(key), false)
})

test('both generations remove only expired visible entries and notify once', (t) => {
  const now = clock(t)
  const notifications = []
  const cache = new QuickLRU({ maxSize: 3, onEviction: (k, v) => notifications.push([k, v]) })
  cache.set('old-expired', 1, { maxAge: 2 }).set('old-live', 2).set('old-live-2', 3)
  cache.set('current-expired', 4, { maxAge: 2 }).set('current-live', 5)
  now.set(102)
  assert.equal(prune(cache), 2)
  assert.deepEqual(notifications.sort(), [
    ['current-expired', 4],
    ['old-expired', 1],
  ])
  assert.deepEqual(
    [...cache.entriesAscending()],
    [
      ['old-live', 2],
      ['old-live-2', 3],
      ['current-live', 5],
    ]
  )
  assert.equal(cache.size, 3)
})

test('expired old shadows disappear without deleting or notifying their live replacement', (t) => {
  const now = clock(t)
  const notifications = []
  const cache = new QuickLRU({ maxSize: 3, onEviction: (k, v) => notifications.push([k, v]) })
  cache.set('shared', 'old', { maxAge: 1 }).set('b', 2).set('c', 3)
  cache.set('shared', 'fresh', { maxAge: 100 })
  now.set(102)
  assert.equal(prune(cache), 0)
  assert.deepEqual(notifications, [])
  assert.equal(cache.peek('shared'), 'fresh')
  assert.equal(cache.__oldCache.has('shared'), false)
  assert.equal(cache.expiresIn('shared'), 98)
  assert.deepEqual(
    [...cache.entriesAscending()],
    [
      ['b', 2],
      ['c', 3],
      ['shared', 'fresh'],
    ]
  )
})

test('expired current duplicates cannot resurrect a live old value', (t) => {
  const now = clock(t)
  const notifications = []
  const cache = new QuickLRU({ maxSize: 3, onEviction: (k, v) => notifications.push([k, v]) })
  cache.set('shared', 'old').set('b', 2).set('c', 3)
  cache.set('shared', 'expired', { maxAge: 1 })
  now.set(101)
  assert.equal(prune(cache), 1)
  assert.deepEqual(notifications, [['shared', 'expired']])
  assert.equal(cache.get('shared'), undefined)
  assert.equal(cache.__oldCache.has('shared'), false)
  assert.equal(prune(cache), 0)
})

test('survivor order, ages, generation placement and future capacity accounting stay unchanged', (t) => {
  const now = clock(t)
  const notifications = []
  const cache = new QuickLRU({ maxSize: 3, onEviction: (k, v) => notifications.push([k, v]) })
  cache.set('a', 1, { maxAge: 50 }).set('b', 2).set('c', 3)
  const old = cache.__oldCache
  cache.set('dead', 4, { maxAge: 1 }).set('d', 5)
  now.set(101)
  assert.equal(prune(cache), 1)
  assert.equal(cache.__oldCache, old)
  assert.deepEqual(
    [...cache.entriesAscending()],
    [
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 5],
    ]
  )
  assert.equal(cache.expiresIn('a'), 49)
  notifications.length = 0
  cache.set('e', 6)
  assert.equal(cache.__oldCache, old)
  assert.deepEqual(notifications, [])
  cache.set('f', 7)
  assert.deepEqual(notifications, [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ])
  assert.deepEqual(
    [...cache.entriesAscending()],
    [
      ['d', 5],
      ['e', 6],
      ['f', 7],
    ]
  )
  assert.equal(cache.size, 3)
  cache.resize(2)
  assert.deepEqual(
    [...cache.entriesAscending()],
    [
      ['e', 6],
      ['f', 7],
    ]
  )
  assert.equal(cache.delete('e'), true)
  assert.equal(cache.get('f'), 7)
})

test('callbacks can replace the removed key and throwing callbacks preserve removal', (t) => {
  const now = clock(t)
  let notifications = 0
  const cache = new QuickLRU({
    maxSize: 10,
    onEviction(key) {
      notifications++
      cache.set(key, 'replacement')
    },
  })
  cache.set('x', 'expired', { maxAge: 1 })
  now.set(101)
  assert.equal(prune(cache), 1)
  assert.equal(cache.peek('x'), 'replacement')
  assert.equal(prune(cache), 0)
  assert.equal(notifications, 1)
  const failure = new Error('consumer callback')
  const throwing = new QuickLRU({
    maxSize: 10,
    onEviction() {
      throw failure
    },
  })
  throwing.set('x', 'expired', { maxAge: 1 })
  now.set(102)
  assert.throws(
    () => prune(throwing),
    (error) => error === failure
  )
  assert.equal(throwing.peek('x'), undefined)
  assert.equal(throwing.size, 0)
})
