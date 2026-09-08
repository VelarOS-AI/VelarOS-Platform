import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'

import {
  manageSystemProcess,
  resolveSystemProcessStatus,
  waitForSystemProcessSpawn,
} from '../src/SystemProcessLifecycle'

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    unref: () => {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess
}

describe('bounded process lifecycle', () => {
  test('settles when termination never responds and close never arrives', async () => {
    const child = fakeChild()
    const signals: string[] = []
    const owned = manageSystemProcess(child, {
      timeoutMs: 5,
      terminateGraceMs: 5,
      terminationDeadlineMs: 35,
      terminate: (signal) => {
        signals.push(signal)
        return new Promise(() => {})
      },
    })
    const result = await owned.completion
    expect(result.timedOut).toBe(true)
    expect(result.cleanupIncomplete).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.stdout!.destroyed).toBe(true)
    expect(await owned.stop('SIGKILL')).toBe(false)
  })

  test('bounds inherited pipe drain after exit and preserves the real exit code', async () => {
    const child = fakeChild()
    const owned = manageSystemProcess(child, { drainTimeoutMs: 10 })
    child.emit('exit', 7, null)
    const result = await owned.completion
    expect(result.exitCode).toBe(7)
    expect(result.cleanupIncomplete).toBe(true)
  })

  test('deduplicates cancellation and timeout and settles once close arrives', async () => {
    const child = fakeChild()
    const controller = new AbortController()
    const signals: string[] = []
    const owned = manageSystemProcess(child, {
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
    const owned = manageSystemProcess(child)
    const spawned = waitForSystemProcessSpawn(child)
    const error = new Error('fixture spawn failure')
    child.emit('error', error)
    await expect(spawned).rejects.toThrow('fixture spawn failure')
    const result = await owned.completion
    expect(result.spawnError).toBe(error)
    expect(owned.exited).toBe(true)
  })

  test('treats missing identity as unknown even for a live PID', async () => {
    expect(await resolveSystemProcessStatus(process.pid, null)).toBe('unknown')
  })
})

test('stop waits for inherited output to close even after the direct process exits', async () => {
  const child = fakeChild()
  const owned = manageSystemProcess(child, {
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
  const owned = manageSystemProcess(child, {
    platform: 'win32',
    drainTimeoutMs: 1_000,
  })
  child.emit('exit', 0, null)
  expect(await resolveSystemProcessStatus(child.pid!, owned.identity, 'win32')).toBe('unknown')
  child.emit('close', 0, null)
  await owned.completion
  expect(await resolveSystemProcessStatus(child.pid!, owned.identity, 'win32')).toBe('exited')
})
