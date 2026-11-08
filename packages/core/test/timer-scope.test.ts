import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'bun:test'

import { TimerScope } from '../src/utils/TimerScope'

function createTimerHost() {
  const callbacks = new Map<number, () => void>()
  let nextHandle = 0
  return {
    callbacks,
    setTimeout(callback: () => void): number {
      const handle = ++nextHandle
      callbacks.set(handle, callback)
      return handle
    },
    clearTimeout(handle: unknown): void {
      callbacks.delete(handle as number)
    },
    fireNext(): void {
      const next = callbacks.entries().next().value
      if (!next) throw new Error('No timer is pending')
      callbacks.delete(next[0])
      next[1]()
    },
  }
}

test('leases cancel their own timer even when scopes allocate the same local id', () => {
  const host = createTimerHost()
  const first = new TimerScope({ host })
  const second = new TimerScope({ host })
  const fired: string[] = []
  try {
    const firstLease = first.after(100, () => fired.push('first'))
    const secondLease = second.after(100, () => fired.push('second'))
    expect(firstLease.id).toBe(secondLease.id)
    expect(firstLease.cancel()).toBe(true)
    expect(firstLease.cancel()).toBe(false)
    expect(secondLease.active).toBe(true)
    host.fireNext()
    expect(fired).toEqual(['second'])
    expect(first.size).toBe(0)
    expect(second.size).toBe(0)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('successful timeout work releases its timer and both cancellation relays', async () => {
  const host = createTimerHost()
  const scope = new TimerScope({ host })
  const source = new AbortController()
  let taskSignal!: AbortSignal
  let started = false
  const pending = scope.withTimeout(
    100,
    (signal) => {
      started = true
      taskSignal = signal
      return 42
    },
    { signal: source.signal }
  )
  expect(started).toBe(true)
  expect(await pending).toBe(42)
  expect(host.callbacks.size).toBe(0)
  expect(scope.size).toBe(0)
  source.abort()
  scope.dispose()
  expect(taskSignal.aborted).toBe(false)
})

test('a deadline ends observation while work retains its real completion', async () => {
  const host = createTimerHost()
  const scope = new TimerScope({ host })
  let finish!: (value: string) => void
  let taskSignal!: AbortSignal
  let completed = false
  const work = new Promise<string>((resolveWork) => {
    finish = resolveWork
  }).then((value) => {
    completed = true
    return value
  })
  const pending = scope.withTimeout(100, (signal) => {
    taskSignal = signal
    return work
  })
  host.fireNext()
  await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(taskSignal.aborted).toBe(true)
  expect(completed).toBe(false)
  expect(scope.size).toBe(0)
  finish('finished later')
  expect(await work).toBe('finished later')
  expect(completed).toBe(true)
  scope.dispose()
})

for (const source of ['signal', 'scope'] as const) {
  test(`${source} cancellation ends a timeout wait and releases its timer`, async () => {
    const host = createTimerHost()
    const scope = new TimerScope({ host })
    const controller = new AbortController()
    let taskSignal!: AbortSignal
    const pending = scope.withTimeout(
      100,
      (signal) => {
        taskSignal = signal
        return new Promise<void>(() => {})
      },
      { signal: controller.signal }
    )
    if (source === 'signal') controller.abort()
    else scope.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(taskSignal.aborted).toBe(true)
    expect(host.callbacks.size).toBe(0)
    expect(scope.size).toBe(0)
    scope.dispose()
  })
}

test('a cancelled source never starts timeout work', async () => {
  const host = createTimerHost()
  const scope = new TimerScope({ host })
  const source = new AbortController()
  source.abort()
  let started = false
  await expect(
    scope.withTimeout(
      100,
      () => {
        started = true
      },
      { signal: source.signal }
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(started).toBe(false)
  expect(host.callbacks.size).toBe(0)
  scope.dispose()
})

test('synchronous cancellation followed by a throw has no unobserved rejection', async () => {
  const timerUrl = pathToFileURL(resolve(import.meta.dir, '../src/utils/TimerScope.ts')).href
  const script = `
    import { TimerScope } from ${JSON.stringify(timerUrl)}
    const unhandled = []
    process.on('unhandledRejection', (error) => unhandled.push(error.message))
    const scope = new TimerScope()
    const source = new AbortController()
    let started = false
    const pending = scope.withTimeout(10000, () => {
      started = true
      source.abort()
      throw new Error('task failed')
    }, { signal: source.signal })
    const synchronous = started
    const failure = await pending.catch((error) => error.message)
    await new Promise((done) => setImmediate(done))
    scope.dispose()
    process.stdout.write(JSON.stringify({ synchronous, failure, unhandled, timers: scope.size }))
  `
  const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const exit = await new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  })
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  expect(JSON.parse(stdout)).toEqual({
    synchronous: true,
    failure: 'task failed',
    unhandled: [],
    timers: 0,
  })
})
