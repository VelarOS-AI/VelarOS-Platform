import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, spyOn, test } from 'bun:test'

import { AppError } from '../src/error'
import { createFileLogTransport } from '../src/logger/node'
import { LogRuntime } from '../src/logger/runtime'

const CoreRoot = resolve(import.meta.dir, '..')

function gate() {
  let open!: () => void
  const promise = new Promise<void>((done) => {
    open = done
  })
  return { promise, open }
}

test('synchronous accepts and write failures do not interrupt other transports', async () => {
  const diagnostics = spyOn(console, 'error').mockImplementation(() => {})
  const runtime = new LogRuntime({ consoleEnabled: false })
  const received: string[] = []
  runtime.addTransport({
    id: 'bad-filter',
    accepts: () => {
      throw new Error('filter failed')
    },
    write: () => {
      throw new Error('a rejected record must never be written')
    },
  })
  runtime.addTransport({
    id: 'bad-writer',
    write: () => {
      throw new Error('write failed')
    },
  })
  runtime.addTransport({
    id: 'healthy',
    write: (record) => {
      if (record.kind === 'message') received.push(record.message)
    },
  })
  try {
    expect(() => runtime.tag('test').info('accepted')).not.toThrow()
    expect(received).toEqual(['accepted'])
    expect(diagnostics).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  } finally {
    diagnostics.mockRestore()
  }
})

test('asynchronous write failures are observed while other transports keep receiving records', async () => {
  const diagnostics = spyOn(console, 'error').mockImplementation(() => {})
  const runtime = new LogRuntime({ consoleEnabled: false })
  const received: string[] = []
  runtime.addTransport({
    id: 'bad-writer',
    write: async () => {
      throw new Error('write failed')
    },
  })
  runtime.addTransport({
    id: 'healthy',
    write: (record) => {
      if (record.kind === 'message') received.push(record.message)
    },
  })
  try {
    runtime.tag('test').info('accepted')
    await runtime.flush()
    expect(received).toEqual(['accepted'])
    expect(diagnostics).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  } finally {
    diagnostics.mockRestore()
  }
})

test('removing transports isolates synchronous and asynchronous disposal failures', async () => {
  const diagnostics = spyOn(console, 'error').mockImplementation(() => {})
  const runtime = new LogRuntime({ consoleEnabled: false })
  const received: string[] = []
  runtime.addTransport({
    id: 'sync',
    write: () => {},
    dispose: () => {
      throw new Error('sync close')
    },
  })
  runtime.addTransport({
    id: 'async',
    write: () => {},
    dispose: async () => {
      throw new Error('async close')
    },
  })
  runtime.addTransport({
    id: 'healthy',
    write: (record) => {
      if (record.kind === 'message') received.push(record.message)
    },
  })
  try {
    expect(runtime.removeTransport('sync')).toBe(true)
    expect(runtime.removeTransport('async')).toBe(true)
    expect(runtime.hasTransport('sync')).toBe(false)
    expect(runtime.hasTransport('async')).toBe(false)
    runtime.tag('test').info('still running')
    await runtime.flush()
    expect(received).toEqual(['still running'])
    expect(diagnostics).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  } finally {
    diagnostics.mockRestore()
  }
})

test('flush waits for accepted writes before asking transports to flush', async () => {
  const runtime = new LogRuntime({ consoleEnabled: false })
  const write = gate()
  let flushed = false
  runtime.addTransport({
    id: 'pending',
    write: () => write.promise,
    flush: () => {
      flushed = true
    },
  })
  runtime.tag('test').info('pending')
  const completion = runtime.flush()
  expect(flushed).toBe(false)
  write.open()
  await completion
  expect(flushed).toBe(true)
  await runtime.dispose()
})

test('flush aggregates synchronous and asynchronous failures after every transport finishes', async () => {
  const runtime = new LogRuntime({ consoleEnabled: false })
  const syncFailure = new Error('sync flush')
  const asyncFailure = new Error('async flush')
  let healthyFlushed = false
  runtime.addTransport({
    id: 'sync',
    write: () => {},
    flush: () => {
      throw syncFailure
    },
  })
  runtime.addTransport({
    id: 'async',
    write: () => {},
    flush: async () => {
      throw asyncFailure
    },
  })
  runtime.addTransport({
    id: 'healthy',
    write: () => {},
    flush: () => {
      healthyFlushed = true
    },
  })
  const failure = await runtime.flush().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AppError)
  expect(failure).toMatchObject({ code: 'UNAVAILABLE' })
  expect((failure as { errors: readonly unknown[] }).errors).toEqual([syncFailure, asyncFailure])
  expect((failure as { errors: readonly unknown[] }).errors[0]).toBe(syncFailure)
  expect((failure as { errors: readonly unknown[] }).errors[1]).toBe(asyncFailure)
  expect((failure as AppError).cause).toBeUndefined()
  expect(healthyFlushed).toBe(true)
})

test('dispose runs all cleanup after flush fails and waits for real asynchronous completion', async () => {
  const runtime = new LogRuntime({ consoleEnabled: false })
  const flushFailure = new Error('flush failed')
  const disposeFailure = new Error('dispose failed')
  const asyncDisposeFailure = new Error('async dispose failed')
  const closing = gate()
  const finish = gate()
  const disposed: string[] = []
  runtime.addTransport({
    id: 'bad',
    write: () => {},
    flush: () => {
      throw flushFailure
    },
    dispose: () => {
      disposed.push('bad')
      throw disposeFailure
    },
  })
  runtime.addTransport({
    id: 'pending',
    write: () => {},
    dispose: () => {
      disposed.push('pending')
      closing.open()
      return finish.promise.then(() => {
        throw asyncDisposeFailure
      })
    },
  })
  runtime.addTransport({
    id: 'healthy',
    write: () => {},
    dispose: () => {
      disposed.push('healthy')
    },
  })
  let completed = false
  const completion = runtime.dispose().then(
    () => {
      completed = true
    },
    (error: unknown) => {
      completed = true
      return error
    }
  )
  await closing.promise
  expect(disposed).toEqual(['bad', 'pending', 'healthy'])
  expect(completed).toBe(false)
  finish.open()
  const failure = await completion
  expect(failure).toBeInstanceOf(AppError)
  expect(failure).toMatchObject({ code: 'UNAVAILABLE' })
  expect((failure as { errors: readonly unknown[] }).errors).toEqual([
    flushFailure,
    disposeFailure,
    asyncDisposeFailure,
  ])
})

test('runtime flush preserves a real file transport write failure', async () => {
  const diagnostics = spyOn(console, 'error').mockImplementation(() => {})
  const root = await mkdtemp(join(tmpdir(), 'core-runtime-log-'))
  const blockedDirectory = join(root, 'not-a-directory')
  await writeFile(blockedDirectory, 'a regular file')
  const filePath = join(blockedDirectory, 'main.log')
  const runtime = new LogRuntime({ consoleEnabled: false })
  runtime.addTransport(createFileLogTransport({ filePath }))
  try {
    runtime.tag('test').info('cannot append to a directory')
    const failure = await runtime.flush().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppError)
    expect(failure).toMatchObject({ code: 'UNAVAILABLE' })
    expect((failure as { errors: readonly unknown[] }).errors).toHaveLength(1)
    expect(diagnostics).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  } finally {
    diagnostics.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test('a closed console pipe cannot crash the logging runtime', async () => {
  const runtimeUrl = pathToFileURL(resolve(CoreRoot, 'src/logger/runtime.ts')).href
  const script = `
    import { LogRuntime } from ${JSON.stringify(runtimeUrl)}
    const runtime = new LogRuntime({ consoleEnabled: true, level: 'debug' })
    const logger = runtime.tag('closed-pipe')
    logger.info('ready')
    const timer = setInterval(() => logger.info('payload', 'x'.repeat(65536)), 1)
    setTimeout(() => {
      clearInterval(timer)
      process.exit(0)
    }, 250)
  `
  const child = spawn(process.execPath, ['--eval', script], {
    cwd: CoreRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((done, reject) => {
    child.stdout.once('data', () => {
      child.stdout.destroy()
      child.stderr.destroy()
      done()
    })
    child.once('error', reject)
  })
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('close', (code, signal) => done({ code, signal }))
  )
  expect(exit).toEqual({ code: 0, signal: null })
})
