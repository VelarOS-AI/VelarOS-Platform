import assert from 'node:assert/strict'
import test from 'node:test'

import { SynchronousCommandRunner } from './packageConsumerGate.mjs'

test('retries transient spawn errors with bounded backoff', () => {
  const waits = []
  const retries = []
  let attempts = 0
  const runner = new SynchronousCommandRunner({
    onRetry: (event) => retries.push(event),
    retryDelayMs: 10,
    spawn: () => {
      attempts += 1
      if (attempts < 3) {
        return {
          error: Object.assign(new Error('resource temporarily unavailable'), {
            code: 'EAGAIN',
          }),
          signal: null,
          status: null,
          stderr: undefined,
          stdout: undefined,
        }
      }
      return {
        error: undefined,
        signal: null,
        status: 0,
        stderr: '',
        stdout: ' packed.tgz \n',
      }
    },
    wait: (delayMs) => waits.push(delayMs),
  })

  assert.equal(runner.run('bun', ['pm', 'pack']), 'packed.tgz')
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [10, 20])
  assert.equal(retries.length, 2)
})

test('retries a signaled child process', () => {
  let attempts = 0
  const runner = new SynchronousCommandRunner({
    onRetry: () => {},
    spawn: () => {
      attempts += 1
      return attempts === 1
        ? {
            error: undefined,
            signal: 'SIGKILL',
            status: null,
            stderr: '',
            stdout: '',
          }
        : {
            error: undefined,
            signal: null,
            status: 0,
            stderr: '',
            stdout: 'ok',
          }
    },
    wait: () => {},
  })

  assert.equal(runner.run('bun', ['pm', 'pack']), 'ok')
  assert.equal(attempts, 2)
})

test('does not retry ordinary nonzero command failures', () => {
  let attempts = 0
  const runner = new SynchronousCommandRunner({
    onRetry: () => assert.fail('ordinary command failure must not retry'),
    spawn: () => {
      attempts += 1
      return {
        error: undefined,
        signal: null,
        status: 2,
        stderr: 'invalid package',
        stdout: 'packing',
      }
    },
    wait: () => {},
  })

  assert.throws(
    () => runner.run('bun', ['pm', 'pack']),
    (error) => {
      assert.match(error.message, /attempt 1\/3/)
      assert.match(error.message, /exit status: 2/)
      assert.match(error.message, /stdout:\npacking/)
      assert.match(error.message, /stderr:\ninvalid package/)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test('reports exhausted spawn failures without assuming output exists', () => {
  const spawnError = Object.assign(new Error('spawnSync bun EAGAIN'), {
    code: 'EAGAIN',
  })
  let attempts = 0
  const runner = new SynchronousCommandRunner({
    onRetry: () => {},
    spawn: () => {
      attempts += 1
      return {
        error: spawnError,
        signal: null,
        status: null,
        stderr: undefined,
        stdout: undefined,
      }
    },
    wait: () => {},
  })

  assert.throws(
    () => runner.run('bun', ['pm', 'pack']),
    (error) => {
      assert.match(error.message, /attempt 3\/3/)
      assert.match(error.message, /spawn error: EAGAIN spawnSync bun EAGAIN/)
      assert.match(error.message, /exit status: null/)
      assert.equal(error.cause, spawnError)
      return true
    },
  )
  assert.equal(attempts, 3)
})
