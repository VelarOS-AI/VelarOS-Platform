import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { BrowserSessionActionQueue } from '../../impl/session/BrowserSessionActionQueue.ts'

// 调用等待有界，实际执行保持互斥；拆卸通过独立路径进行，不能以 clear 重开普通动作链。
void test('a timed out unsettled action isolates its session while other sessions remain usable', async () => {
  const queue = new BrowserSessionActionQueue()
  const never = () => new Promise(() => {})
  const first = queue.run('s1', never, { holdCapMs: 10 })
  const next = queue.run('s1', async () => 'must not run')
  await Promise.all([
    assert.rejects(first, { code: 'TIMEOUT' }),
    assert.rejects(next, { code: 'CLOSED' }),
  ])
  queue.clear('s1')
  await assert.rejects(
    queue.run('s1', async () => 'must not run'),
    { code: 'CLOSED' }
  )
  assert.equal(await queue.run('new', async () => 'recovered'), 'recovered')
})

void test('aborting a queued action preserves the predecessor barrier for later work', async () => {
  const queue = new BrowserSessionActionQueue()
  const controller = new AbortController()
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const first = queue.run('s2', async () => held)
  const cancelled = queue.run('s2', async () => 'must not run', { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled)
  let started = false
  const next = queue.run('s2', async () => {
    started = true
    return 'ok'
  })
  await Promise.resolve()
  assert.equal(started, false)
  release()
  await first
  assert.equal(await next, 'ok')
})
