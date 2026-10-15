// 用途：独立验收真实 p-retry 的逐次截止、取消竞争、资源释放与公开交付。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const library = await import(pathToFileURL(resolve('index.js')))
const pRetry = library.default
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const options = { retries: 1, minTimeout: 0, attemptTimeout: 30 }
const requireFeature = () =>
  assert.equal(typeof library.TimeoutError, 'function', 'exports a TimeoutError class')
const bounded = (promise) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation failed to settle')), 1500)
    }),
  ]).finally(() => clearTimeout(timer))
}

test('exports a TimeoutError class', () => {
  requireFeature()
  assert(library.TimeoutError.prototype instanceof Error)
})

test('timeout abort reason and callbacks share identity; fresh successful signal stays live', async () => {
  requireFeature()
  const signals = [],
    failures = []
  const answer = await bounded(
    pRetry(
      (attempt, { signal }) => {
        signals.push(signal)
        if (attempt === 1) return new Promise(() => {})
        assert.equal(signal.aborted, false)
        return 73
      },
      { ...options, onFailedAttempt: ({ error }) => failures.push(error) }
    )
  )
  assert.equal(answer, 73)
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[0].reason, failures[0])
  assert(failures[0] instanceof library.TimeoutError)
  assert.equal(failures[0].name, 'TimeoutError')
  assert.equal(failures[0].attemptNumber, 1)
  assert.equal(failures[0].attemptTimeout, 30)
  await sleep(60)
  assert.equal(signals[1].aborted, false)
})

test('final timeout observes retry count and callback ordering', async () => {
  requireFeature()
  const seen = []
  await assert.rejects(
    bounded(
      pRetry(() => new Promise(() => {}), {
        ...options,
        shouldConsumeRetry: ({ attemptNumber }) => {
          seen.push(`consume:${attemptNumber}`)
          return true
        },
        onFailedAttempt: ({ attemptNumber }) => {
          seen.push(`failed:${attemptNumber}`)
        },
        shouldRetry: ({ attemptNumber }) => {
          seen.push(`retry:${attemptNumber}`)
          return true
        },
      })
    ),
    (error) => error instanceof library.TimeoutError && error.attemptNumber === 2
  )
  assert.deepEqual(seen, ['consume:1', 'failed:1', 'retry:1', 'consume:2', 'failed:2'])
})

test('a timeout may leave the retry budget unconsumed', async () => {
  requireFeature()
  const consumed = []
  const value = await bounded(
    pRetry((attempt) => (attempt < 3 ? new Promise(() => {}) : 'ready'), {
      ...options,
      shouldConsumeRetry: ({ retriesConsumed }) => {
        consumed.push(retriesConsumed)
        return false
      },
    })
  )
  assert.equal(value, 'ready')
  assert.deepEqual(consumed, [0, 0])
})

test('invalid attempt timeouts fail before side effects', async () => {
  requireFeature()
  for (const attemptTimeout of [0, -1, NaN, -Infinity, '20', null, true, {}]) {
    let touched = false
    await assert.rejects(
      pRetry(
        () => {
          touched = true
        },
        {
          ...options,
          attemptTimeout,
          onFailedAttempt: () => {
            touched = true
          },
        }
      ),
      TypeError
    )
    assert.equal(touched, false)
  }
})

test('disabled deadlines retain results and supply an attempt signal', async () => {
  requireFeature()
  for (const attemptTimeout of [undefined, Infinity]) {
    const inputOptions = { retries: 0 }
    if (attemptTimeout !== undefined) inputOptions.attemptTimeout = attemptTimeout
    assert.equal(
      await bounded(
        pRetry(async (number, { signal }) => {
          assert.equal(number, 1)
          assert(signal instanceof AbortSignal)
          assert.equal(signal.aborted, false)
          await sleep(40)
          return 'ok'
        }, inputOptions)
      ),
      'ok'
    )
  }
})

test('parent abort settles an uncooperative input with exact non-Error reason', async () => {
  requireFeature()
  const parent = new AbortController(),
    reason = { kind: 'caller-cancelled' }
  let active,
    calls = 0,
    failed = 0
  const pending = pRetry(
    (_, { signal }) => {
      active = signal
      calls++
      return new Promise(() => {})
    },
    {
      ...options,
      attemptTimeout: 900,
      signal: parent.signal,
      onFailedAttempt: () => {
        failed++
      },
    }
  )
  await sleep(5)
  parent.abort(reason)
  await assert.rejects(bounded(pending), (error) => error === reason)
  assert.equal(active.reason, reason)
  assert.equal(calls, 1)
  assert.equal(failed, 0)
})

for (const callback of ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']) {
  test(`parent abort during ${callback} ignores late callback rejection`, async () => {
    requireFeature()
    const parent = new AbortController(),
      reason = new Error('caller stop')
    let started,
      rejectCallback,
      calls = 0
    const entered = new Promise((done) => {
      started = done
    })
    const unhandled = [],
      later = []
    const onUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      const callbacks = {
        shouldConsumeRetry: () => {
          later.push('consume')
          return true
        },
        onFailedAttempt: () => {
          later.push('failed')
        },
        shouldRetry: () => {
          later.push('retry')
          return true
        },
      }
      callbacks[callback] = () => {
        started()
        return new Promise((_, reject) => {
          rejectCallback = reject
        })
      }
      const pending = pRetry(
        () => {
          calls++
          throw new Error('temporary')
        },
        {
          ...options,
          signal: parent.signal,
          ...callbacks,
        }
      )
      await bounded(entered)
      const before = [...later]
      parent.abort(reason)
      await assert.rejects(bounded(pending), (error) => error === reason)
      rejectCallback(new Error('late callback'))
      await sleep(40)
      assert.equal(calls, 1)
      assert.deepEqual(later, before)
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
}

test('late input rejection after timeout is observed', async () => {
  requireFeature()
  const unhandled = [],
    capture = (error) => unhandled.push(error)
  process.on('unhandledRejection', capture)
  try {
    let fail
    const pending = pRetry(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
      { ...options, retries: 0 }
    )
    await assert.rejects(bounded(pending), (error) => error instanceof library.TimeoutError)
    fail(new Error('late input'))
    await sleep(40)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', capture)
  }
})

test('parent abort listeners and successful attempt deadlines are disposed', async () => {
  requireFeature()
  const parent = new AbortController(),
    live = new Set(),
    signals = []
  const add = parent.signal.addEventListener.bind(parent.signal),
    remove = parent.signal.removeEventListener.bind(parent.signal)
  parent.signal.addEventListener = (type, fn, opts) => {
    if (type === 'abort') live.add(fn)
    return add(type, fn, opts)
  }
  parent.signal.removeEventListener = (type, fn, opts) => {
    if (type === 'abort') live.delete(fn)
    return remove(type, fn, opts)
  }
  for (let i = 0; i < 12; i++) {
    assert.equal(
      await pRetry(
        (_, { signal }) => {
          signals.push(signal)
          return i
        },
        { ...options, signal: parent.signal }
      ),
      i
    )
    assert.equal(live.size, 0)
  }
  parent.abort(new Error('later'))
  await sleep(45)
  assert(signals.every((signal) => !signal.aborted))
})

test('pre-aborted parent invokes no input or callbacks', async () => {
  requireFeature()
  const parent = new AbortController(),
    reason = new Error('already stopped')
  parent.abort(reason)
  let touched = false
  await assert.rejects(
    pRetry(
      () => {
        touched = true
      },
      {
        ...options,
        signal: parent.signal,
        onFailedAttempt: () => {
          touched = true
        },
      }
    ),
    (error) => error === reason
  )
  assert.equal(touched, false)
})

test('original AbortError and makeRetriable integrate with the new deadline', async () => {
  requireFeature()
  const original = new Error('stop'),
    calls = []
  await assert.rejects(
    pRetry(
      () => {
        throw new library.AbortError(original)
      },
      { ...options, onFailedAttempt: () => calls.push('failed') }
    ),
    (error) => error === original
  )
  assert.deepEqual(calls, [])
  let count = 0
  const retriable = library.makeRetriable(
    (value) => (++count === 1 ? new Promise(() => {}) : value),
    options
  )
  assert.equal(await bounded(retriable('kept')), 'kept')
})

test('public type tests and runnable offline example succeed', async () => {
  requireFeature()
  const types = spawnSync(process.execPath, ['node_modules/tsd/dist/cli.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(types.status, 0, types.stdout + types.stderr)
  const content = await readFile(resolve('index.d.ts'), 'utf8')
  assert.match(content, /attemptTimeout/u)
  assert.match(content, /TimeoutError/u)
  assert.match(content, /AbortSignal/u)
  const example = spawnSync(process.execPath, ['examples/attempt-timeout.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(example.status, 0, example.stdout + example.stderr)
  assert((await readFile(resolve('readme.md'), 'utf8')).includes('attemptTimeout'))
})
