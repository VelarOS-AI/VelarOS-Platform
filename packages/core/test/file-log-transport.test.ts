import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'bun:test'

import { AppError } from '../src/error'
import { createFileLogTransport, resolveDatedLogFilePath } from '../src/logger/node'
import type { LogRecord } from '../src/logger/types'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function temporaryLog(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'core-file-log-'))
  roots.push(root)
  return join(root, 'nested', 'main.log')
}
function record(message: string, timestamp = new Date(2026, 8, 22, 23, 59)): LogRecord {
  return {
    kind: 'message',
    level: 'info',
    message,
    timestamp,
    scope: 'test',
    args: [],
    context: {},
    environment: 'test',
    platform: 'node',
  }
}
async function lines(path: string): Promise<Array<Record<string, any>>> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

test('ordered JSONL snapshots rotate using each record local date and flush before returning', async () => {
  const path = await temporaryLog()
  const transport = createFileLogTransport({ filePath: path })
  const first = record('first')
  first.context.counter = 1
  const writes = [
    transport.write(first),
    transport.write(record('second')),
    transport.write(record('tomorrow', new Date(2026, 8, 23))),
  ]
  first.context.counter = 2
  await transport.flush?.()
  await Promise.all(writes)
  const today = await lines(resolveDatedLogFilePath(path, first.timestamp))
  expect(today.map((entry) => entry.message)).toEqual(['first', 'second'])
  expect(today[0]!.context.counter).toBe(1)
  expect((await lines(resolveDatedLogFilePath(path, new Date(2026, 8, 23))))[0]!.message).toBe(
    'tomorrow'
  )
  await transport.dispose?.()
})

test('errors, BigInt and cyclic payloads retain diagnostics without breaking writes', async () => {
  const path = await temporaryLog()
  const transport = createFileLogTransport({ filePath: path })
  const entry = record('diagnostics')
  entry.context.self = entry.context
  entry.context.count = 4n
  if (entry.kind === 'message')
    entry.error = new AppError('IO', 'fixture failure', new Error('cause'))
  await transport.write(entry)
  const [saved] = await lines(resolveDatedLogFilePath(path, entry.timestamp))
  expect(saved!.context.count).toBe('4')
  expect(saved!.context.self).toBe('[Circular]')
  expect(saved!.error.code).toBe('IO')
  expect(saved!.error.stack).toContain('fixture failure')
  expect(saved!.error.cause.message).toBe('cause')
  await transport.dispose?.()
})

test('a failed write is reported and subsequent writes can recover', async () => {
  const path = await temporaryLog()
  const entry = record('recovered')
  const datedPath = resolveDatedLogFilePath(path, entry.timestamp)
  await mkdir(datedPath, { recursive: true })
  const transport = createFileLogTransport({ filePath: path })
  await expect(Promise.resolve(transport.write(record('failed')))).rejects.toThrow()
  await rm(datedPath, { recursive: true })
  await transport.write(entry)
  await expect(Promise.resolve(transport.flush?.())).rejects.toThrow()
  await transport.flush?.()
  expect((await lines(datedPath)).map((line) => line.message)).toEqual(['recovered'])
  await transport.dispose?.()
})

test('closing rejects new writes and shares a receipt for accepted records', async () => {
  const path = await temporaryLog()
  const transport = createFileLogTransport({ filePath: path })
  const pending = transport.write(record('accepted'))
  const completion = transport.dispose?.()
  expect(transport.dispose?.()).toBe(completion)
  await expect(Promise.resolve(transport.write(record('too late')))).rejects.toThrow('closed')
  await completion
  await pending
  expect(await lines(resolveDatedLogFilePath(path, record('').timestamp))).toHaveLength(1)
})

test('browser logger entry stays independent from Node file logging', async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/logger/index.ts')],
    target: 'browser',
  })
  expect(result.success).toBe(true)
})
