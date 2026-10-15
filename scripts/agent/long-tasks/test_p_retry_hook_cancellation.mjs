// 冻结真实异步回调验收：取消、迟到结果、监听清理与已有重试合同。
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const { default: pRetry, AbortError } = await import(pathToFileURL(join(process.cwd(), 'index.js')))
const hooks = ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const hook of hooks) {
  test(`abort must settle while a hook is pending: ${hook}`, async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const reason = { cancelled: hook }
    const calls = []
    let attempts = 0
    const options = { retries: 2, minTimeout: 0, signal: controller.signal }
    for (const name of hooks)
      options[name] = () => {
        calls.push(name)
        return true
      }
    options[hook] = () => {
      calls.push(hook)
      entered.resolve()
      return pending.promise
    }
    const outcome = pRetry(() => {
      attempts++
      throw new Error('input')
    }, options).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    await entered.promise
    controller.abort(reason)
    const observed = await Promise.race([outcome, pause(350).then(() => ({ timeout: true }))])
    pending.reject(new Error('late callback rejection'))
    await pause(20)
    assert.equal(observed.timeout, undefined, 'abort must settle while a hook is pending')
    assert.equal(observed.error, reason)
    assert.equal(attempts, 1)
    assert.deepEqual(calls, hooks.slice(0, hooks.indexOf(hook) + 1))
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })

  test(`callback-triggered abort before returning a promise: ${hook}`, async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers()
    const reason = new Error('synchronous abort')
    const outcome = pRetry(
      () => {
        throw new Error('input')
      },
      {
        retries: 2,
        minTimeout: 0,
        signal: controller.signal,
        [hook]: () => {
          controller.abort(reason)
          return pending.promise
        },
      }
    ).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    const observed = await Promise.race([outcome, pause(350).then(() => ({ timeout: true }))])
    pending.resolve(true)
    await pause(10)
    assert.equal(observed.timeout, undefined, 'abort must settle while a hook is pending')
    assert.equal(observed.error, reason)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}

test('successful retries preserve order, frozen contexts and clean abort listeners', async () => {
  const controller = new AbortController()
  const calls = []
  const error = new Error('retry')
  let attempts = 0
  const options = { retries: 3, minTimeout: 0, signal: controller.signal }
  for (const hook of hooks)
    options[hook] = async (context) => {
      assert.equal(Object.isFrozen(context), true)
      assert.equal(context.error, error)
      assert.equal(context.attemptNumber, attempts)
      calls.push(hook)
      await pause(1)
      return true
    }
  const result = await pRetry(() => {
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    if (++attempts < 3) throw error
    return 'done'
  }, options)
  assert.equal(result, 'done')
  assert.deepEqual(calls, [...hooks, ...hooks])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('hook errors, AbortError and non-consuming retries retain their contracts', async () => {
  for (const hook of hooks) {
    const error = new Error(hook)
    await assert.rejects(
      pRetry(
        () => {
          throw new Error('input')
        },
        {
          minTimeout: 0,
          [hook]: async () => {
            throw error
          },
        }
      ),
      (value) => value === error
    )
  }
  const original = new Error('abort error')
  await assert.rejects(
    pRetry(
      () => {
        throw new AbortError(original)
      },
      {
        onFailedAttempt: () => assert.fail('AbortError must skip hooks'),
      }
    ),
    (value) => value === original
  )
  let attempts = 0
  const contexts = []
  assert.equal(
    await pRetry(
      () => {
        if (++attempts < 4) throw new Error('transient')
        return 42
      },
      {
        retries: 1,
        minTimeout: 0,
        shouldConsumeRetry: () => false,
        onFailedAttempt: (context) => contexts.push(context),
      }
    ),
    42
  )
  assert(contexts.every((context) => context.retriesConsumed === 0 && context.retryDelay === 0))
})

test('an already aborted signal starts no input or callback work', async () => {
  const controller = new AbortController()
  const reason = { already: true }
  controller.abort(reason)
  await assert.rejects(
    pRetry(() => assert.fail('input started'), {
      signal: controller.signal,
      onFailedAttempt: () => assert.fail('hook started'),
    }),
    (error) => error === reason
  )
})
