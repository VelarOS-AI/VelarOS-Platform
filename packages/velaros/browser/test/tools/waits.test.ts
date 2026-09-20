// 用途：钉住宿主轮询的等待——判定式为真就交回它的值；跳转途中那一拍没有回话算没到、接着判；
// 页面里抛错立刻失败（不空等到超时）；框架没了立刻失败；到点没成立抛 TIMEOUT，message 说最后看到什么。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../../contract/constants.js'
import type { BrowserScriptOutcome } from '../../types/browser.js'
import { pollPageCondition, waitForPendingEvent, waitForProtocolEvent } from '../../utils/waits.js'

/** 一拍的结局：值按 JSON 交回。 */
function outcome(value: unknown): BrowserScriptOutcome {
  return { url: 'https://example.test/', ok: true, json: JSON.stringify(value) }
}

const signal = new AbortController().signal

void describe('宿主轮询的等待', () => {
  void test('判定式为真就交回它的值；跳转途中没有回话的那一拍接着判', async () => {
    const answers: Array<() => Promise<BrowserScriptOutcome>> = [
      async () => outcome(false),
      async () => {
        throw new AppError('TIMEOUT', '页面在求值途中导航离开')
      },
      async () => outcome({ count: 3 }),
    ]
    const value = await pollPageCondition({ evaluate: () => answers.shift()!(), timeoutMs: 5_000, intervalMs: 50, abortSignal: signal })
    assert.deepEqual(value, { count: 3 })
    assert.equal(answers.length, 0)
  })

  void test('页面里抛错立刻失败，框架没了也立刻失败', async () => {
    const startedAt = Date.now()
    await assert.rejects(
      pollPageCondition({
        evaluate: async () => ({ url: 'https://example.test/', ok: false, error: { name: 'TypeError', message: 'x is null' } }),
        timeoutMs: 5_000,
        intervalMs: 50,
        abortSignal: signal,
      }),
      (error) => AppError.from(error).code === BrowserErrorCodes.scriptFailed
    )
    await assert.rejects(
      pollPageCondition({
        evaluate: async () => {
          throw new AppError(BrowserErrorCodes.frameNotFound, '框架没了')
        },
        timeoutMs: 5_000,
        intervalMs: 50,
        abortSignal: signal,
      }),
      (error) => AppError.from(error).code === BrowserErrorCodes.frameNotFound
    )
    assert.ok(Date.now() - startedAt < 1_000)
  })

  void test('到点没成立抛 TIMEOUT，message 带最后一次看到的值', async () => {
    await assert.rejects(
      pollPageCondition({ evaluate: async () => outcome(0), timeoutMs: 200, intervalMs: 50, abortSignal: signal }),
      (error) => {
        const failure = AppError.from(error)
        return failure.code === 'TIMEOUT' && failure.message.includes('判定式的值是 0')
      }
    )
  })

  void test('挂起事件：等到了交回事件，等不到抛 TIMEOUT 并列出此刻挂着的', async () => {
    const download = { id: 'download-1', kind: 'download' as const, createdAt: 1, details: {} }
    const event = await waitForPendingEvent({ kind: 'download', timeoutMs: 1_000, abortSignal: signal, listPendingEvents: async () => ({ pending: [download], capturedAt: 1 }) })
    assert.equal(event.id, 'download-1')
    await assert.rejects(
      waitForPendingEvent({ kind: 'dialog', timeoutMs: 100, abortSignal: signal, listPendingEvents: async () => ({ pending: [download], capturedAt: 1 }) }),
      (error) => AppError.from(error).code === 'TIMEOUT' && AppError.from(error).message.includes('download')
    )
  })

  void test('CDP 事件：从 after 之后找第一条匹配的，游标跟着往前走', async () => {
    const reads: number[] = []
    const found = await waitForProtocolEvent({
      method: 'Network.responseReceived',
      after: 7,
      timeoutMs: 1_000,
      abortSignal: signal,
      readEvents: async (query) => {
        reads.push(query.after ?? 0)
        return reads.length < 2
          ? { events: [], last: 9, dropped: 0 }
          : { events: [{ seq: 10, method: 'Network.responseReceived', params: { requestId: 'r1' }, session: null }], last: 10, dropped: 0 }
      },
    })
    assert.equal(found.seq, 10)
    assert.deepEqual(reads, [7, 9])
  })
})
