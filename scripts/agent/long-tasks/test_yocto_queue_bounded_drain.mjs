import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { runTsdConsumer } from './type-consumer.mjs'

const { default: Queue } = await import(pathToFileURL(resolve('index.js')))
const queueOf = (...values) => {
  const queue = new Queue()
  for (const value of values) queue.enqueue(value)
  return queue
}

test('zero is a non-consuming limit and finite limits preserve FIFO identity', () => {
  const object = {},
    symbol = Symbol('key')
  const queue = queueOf(undefined, object, null, symbol)
  assert.deepEqual([...queue.drain(0)], [], 'drain(0) must not remove values')
  assert.equal(queue.size, 4)
  assert.deepEqual([...queue.drain(-0)], [])
  assert.deepEqual([...queue.drain(1)], [undefined])
  assert.equal(queue.peek(), object)
  assert.equal(queue.size, 3)
  const drained = [...queue.drain(2)]
  assert.equal(drained[0], object)
  assert.equal(drained[1], null)
  assert.deepEqual([...queue], [symbol])
  assert.equal(queue.size, 1)
})

test('invalid limits throw RangeError eagerly without coercion or queue mutation', () => {
  const queue = queueOf('a', 'b')
  let coerced = false
  for (const limit of [
    -1,
    -Infinity,
    NaN,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    '2',
    null,
    false,
    2n,
    {},
    {
      valueOf() {
        coerced = true
        return 2
      },
    },
  ]) {
    assert.throws(() => queue.drain(limit), RangeError)
    assert.equal(queue.size, 2)
    assert.deepEqual([...queue], ['a', 'b'])
  }
  assert.equal(coerced, false)
})

test('default, undefined, Infinity and oversized safe limits retain existing drain behavior', () => {
  for (const args of [[], [undefined], [Infinity], [Number.MAX_SAFE_INTEGER]]) {
    const queue = queueOf(1, undefined, 3)
    assert.deepEqual([...queue.drain(...args)], [1, undefined, 3])
    assert.equal(queue.size, 0)
    queue.enqueue(4)
    queue.enqueue(5)
    assert.deepEqual([...queue], [4, 5])
    assert.deepEqual([...queue.drain()], [4, 5])
    assert.equal(queue.size, 0)
  }
})

test('bounded draining is lazy and counts only this iterator removals under live interleaving', () => {
  const queue = queueOf('a', 'b', 'c')
  const iterator = queue.drain(2)
  assert.equal(iterator[Symbol.iterator](), iterator)
  assert.equal(queue.size, 3)
  assert.equal(queue.dequeue(), 'a')
  queue.enqueue('d')
  assert.deepEqual(iterator.next(), { value: 'b', done: false })
  assert.equal(queue.size, 2)
  assert.equal(queue.dequeue(), 'c')
  assert.deepEqual(iterator.next(), { value: 'd', done: false })
  assert.equal(queue.size, 0)
  queue.enqueue('e')
  assert.equal(iterator.next().done, true)
  assert.deepEqual([...queue], ['e'])
})

test('return, throw and breaking iteration leave remaining values untouched', () => {
  const queue = queueOf(1, 2, 3, 4)
  const returned = queue.drain(3)
  assert.equal(returned.next().value, 1)
  assert.deepEqual(returned.return('stop'), { value: 'stop', done: true })
  assert.equal(returned.next().done, true)
  assert.deepEqual([...queue], [2, 3, 4])
  const thrown = queue.drain(3)
  assert.equal(thrown.next().value, 2)
  const failure = new Error('consumer stop')
  assert.throws(
    () => thrown.throw(failure),
    (error) => error === failure
  )
  assert.equal(thrown.next().done, true)
  assert.deepEqual([...queue], [3, 4])
  for (const value of queue.drain(2)) {
    assert.equal(value, 3)
    break
  }
  assert.deepEqual([...queue], [4])
  assert.equal(queue.size, 1)
})

test('concurrent drain iterators and clear/enqueue preserve linked queue state', () => {
  const queue = queueOf(1, 2, 3, 4)
  const one = queue.drain(1),
    two = queue.drain(2)
  assert.equal(one.next().value, 1)
  assert.equal(two.next().value, 2)
  assert.equal(one.next().done, true)
  assert.equal(two.next().value, 3)
  assert.equal(two.next().done, true)
  assert.deepEqual([...queue], [4])
  const pending = queue.drain(2)
  queue.clear()
  queue.enqueue(5)
  assert.equal(pending.next().value, 5)
  assert.equal(pending.next().done, true)
  queue.enqueue(6)
  assert.equal(pending.next().done, true)
  assert.equal(queue.dequeue(), 6)
  assert.equal(queue.size, 0)
  const large = new Queue()
  for (let i = 0; i < 20000; i++) large.enqueue(i)
  assert.deepEqual([...large.drain(3)], [0, 1, 2])
  assert.equal(large.size, 19997)
  assert.equal(large.peek(), 3)
  assert.equal([...large].length, 19997)
})

test('a default live iterator observes later enqueues until it first reaches empty', () => {
  const queue = queueOf(1)
  const iterator = queue.drain()
  assert.equal(iterator.next().value, 1)
  queue.enqueue(undefined)
  assert.deepEqual(iterator.next(), { value: undefined, done: false })
  assert.equal(iterator.next().done, true)
  queue.enqueue(2)
  assert.equal(iterator.next().done, true)
  assert.deepEqual([...queue], [2])
  const zero = queue.drain(0)
  assert.equal(zero.next().done, true)
  assert.equal(queue.size, 1)
})

test('public generic declarations accept optional numeric limits and reject other shapes', async () => {
  const result = await runTsdConsumer(
    `import {expectType,expectError} from ${JSON.stringify(resolve('node_modules/tsd/dist/index.js'))};\nimport Queue from ${JSON.stringify(resolve('index.js'))};\nconst queue=new Queue<{tag:number}>();\nexpectType<IterableIterator<{tag:number}>>(queue.drain(2));\nexpectType<IterableIterator<{tag:number}>>(queue.drain());\nexpectType<IterableIterator<{tag:number}>>(queue.drain(undefined));\nexpectError(queue.drain('2'));\nexpectError(queue.drain({limit:2}));\n`
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
