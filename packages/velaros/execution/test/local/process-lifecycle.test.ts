import { describe, expect, test } from 'bun:test'

import { shellProcessManager } from '../../impl/local/ShellProcessManager.js'
import { fakeChild } from '../../spec/support'
import { waitForProcessSpawn } from '../../utils/process.js'

describe('bounded process lifecycle', () => {
  test('bounds inherited pipe drain after exit and preserves the real exit code', async () => {
    const child = fakeChild()
    const owned = shellProcessManager.manage(child, { drainTimeoutMs: 10 })
    child.emit('exit', 7, null)
    const result = await owned.completion
    expect(result.exitCode).toBe(7)
    expect(result.cleanupIncomplete).toBe(true)
  })

  test('deduplicates cancellation and timeout and settles once close arrives', async () => {
    const child = fakeChild()
    const controller = new AbortController()
    const signals: string[] = []
    const owned = shellProcessManager.manage(child, {
      timeoutMs: 8,
      terminateGraceMs: 12,
      terminationDeadlineMs: 40,
      abortSignal: controller.signal,
      terminate: async (signal) => {
        signals.push(signal)
        return true
      },
    })
    controller.abort()
    setTimeout(() => {
      child.emit('exit', null, 'SIGTERM')
      child.emit('close', null, 'SIGTERM')
    }, 18)
    const result = await owned.completion
    expect(result.aborted).toBe(true)
    expect(result.cleanupIncomplete).toBe(false)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('handles spawn failure without an uncaught error or a running receipt', async () => {
    const child = fakeChild()
    const owned = shellProcessManager.manage(child)
    const spawned = waitForProcessSpawn(child)
    const error = new Error('fixture spawn failure')
    child.emit('error', error)
    await expect(spawned).rejects.toThrow('fixture spawn failure')
    const result = await owned.completion
    expect(result.spawnError).toBe(error)
    expect(owned.exited).toBe(true)
  })

  test('treats missing identity as unknown even for a live PID', async () => {
    expect(await shellProcessManager.resolveStatus(process.pid, null)).toBe('unknown')
  })
})

test('stop waits for inherited output to close even after the direct process exits', async () => {
  const child = fakeChild()
  const owned = shellProcessManager.manage(child, {
    platform: 'win32',
    drainTimeoutMs: 1_000,
  })
  child.emit('exit', 0, null)
  let stopped = false
  const pending = owned.stop().then((result) => {
    stopped = true
    return result
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  child.emit('close', 0, null)
  expect(await pending).toBe(true)
})

test('status remains unconfirmed between root exit and the final close receipt', async () => {
  const child = Object.assign(fakeChild(), { pid: 9_876_543 })
  const owned = shellProcessManager.manage(child, {
    platform: 'win32',
    drainTimeoutMs: 1_000,
  })
  child.emit('exit', 0, null)
  expect(await shellProcessManager.resolveStatus(child.pid!, owned.identity, 'win32')).toBe(
    'unknown'
  )
  child.emit('close', 0, null)
  await owned.completion
  expect(await shellProcessManager.resolveStatus(child.pid!, owned.identity, 'win32')).toBe(
    'exited'
  )
})

for (const lateClose of [false, true]) {
  test(`a termination retry cannot turn an incomplete receipt into success (late close=${lateClose})`, async () => {
    const child = fakeChild()
    let terminations = 0
    const owned = shellProcessManager.manage(child, {
      platform: 'win32',
      terminationDeadlineMs: 10,
      terminate: async () => {
        terminations++
        if (terminations > 1) {
          child.emit('exit', null, 'SIGKILL')
          if (lateClose) child.emit('close', null, 'SIGKILL')
        }
        return true
      },
    })
    expect(await owned.stop('SIGKILL')).toBe(false)
    const incomplete = await owned.completion
    expect(incomplete.cleanupIncomplete).toBe(true)
    expect(owned.exited).toBe(false)
    // 重试中观察到根进程退出，不足以撤销之前未确认的整棵树/继承管道回执。
    expect(await owned.stop('SIGKILL')).toBe(false)
    expect(terminations).toBe(2)
    expect(owned.exited).toBe(true)
    expect(owned.result).toBe(incomplete)
    expect(await owned.stop('SIGKILL')).toBe(false)
  })
}
