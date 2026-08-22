import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { BrowserSessionActionQueue } from '../../dist/core/index.js'

/**
 * 会话串行队列的**不可协商契约**：一条永不 settle 的动作，不许换来一条永久瘫痪的会话。
 *
 * 这三组用例钉的是一条 brick 级事故（AGENT-12）：`webContents.executeJavaScript` 在渲染进程
 * 被脚本卡死时永不返回，它占死队头，后面的 `presentPage` / `closeSession` 全部排在死结后面，
 * 后续页面动作 14 分钟没有回执、abort 无效、只能重启应用。
 */

const never = () => new Promise(() => {})

// ── ① 死结必须在上限到点后放行队伍 ────────────────────────────

void test('a never-settling action releases the queue at the hold cap', async () => {
  const queue = new BrowserSessionActionQueue()

  const stuck = queue.run('s1', never, { holdCapMs: 30, label: 'stuck' })
  const after = queue.run('s1', async () => 'ran', { holdCapMs: 1_000 })

  await assert.rejects(stuck, (error) => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
  // 后继不但没被拖死，而且真的跑到了。
  assert.equal(await after, 'ran')
})

// ── ② 排队期间中止必须立刻退出，且不拖累后继 ──────────────────

void test('aborting while queued rejects at once and does not hold the line', async () => {
  const queue = new BrowserSessionActionQueue()
  const controller = new AbortController()

  const holder = queue.run('s2', never, { holdCapMs: 120 })
  let startedAfterAbort = false
  const abortable = queue.run('s2', async () => 'never-reached', {
    signal: controller.signal,
    holdCapMs: 1_000,
  })
  controller.abort()

  await assert.rejects(abortable)
  // 中止者退出排队后，队伍照常往下走（holder 由上限放行）。
  const next = queue.run('s2', async () => {
    startedAfterAbort = true
    return 'ok'
  }, { holdCapMs: 1_000 })

  await assert.rejects(holder)
  assert.equal(await next, 'ok')
  assert.equal(startedAfterAbort, true)
})

// ── ③ 拆卸路径必须能绕过死结 ─────────────────────────────────

void test('clear() lets teardown start immediately instead of queueing behind a jam', async () => {
  const queue = new BrowserSessionActionQueue()

  const jam = queue.run('s3', never, { holdCapMs: 5_000 })
  // `closeSession` 就是这么做的：先丢链，再排拆卸动作。
  queue.clear('s3')

  const teardown = await Promise.race([
    queue.run('s3', async () => 'torn-down', { holdCapMs: 1_000 }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 500)),
  ])

  assert.equal(teardown, 'torn-down')
  // 卡住的那个仍在原地等自己的上限，不影响结论。
  jam.catch(() => undefined)
})
