import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { BrowserPerformanceOrchestrator } from '../../impl/engines/BrowserPerformanceOrchestrator.js'

test('INV-35 heap chunks reach an owned file before capture ends, preserve Unicode, and drain on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-heap-'))
  const name = 'capture.heapsnapshot'
  const target = join(root, name)
  const prefix = '{"value":"前'
  const suffix = '😀后"}'
  const expected = prefix + suffix
  const cancelReason = new Error('heap caller cancelled')
  const driverFailure = new Error('heap driver failed')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let mode: 'success' | 'cancel' | 'failure' = 'success'
  let controller = new AbortController()
  let inFlight: Promise<unknown> | undefined
  const driver = {
    getURL: () => 'https://example.test/heap',
    captureHeapSnapshot: async (sink: (chunk: string) => void) => {
      sink(prefix)
      const files = await readdir(root)
      const temporary = files.find((file) => file !== name)
      assert.ok(temporary)
      assert.equal(await readFile(join(root, temporary), 'utf8'), prefix)
      if (mode === 'failure') throw driverFailure
      if (mode === 'cancel') {
        controller.abort(cancelReason)
        assert.doesNotThrow(() => sink('discarded after cancellation'))
        entered.resolve()
        await release.promise
      } else {
        sink('\ud83d')
        sink('\ude00后"}')
      }
      return { chunks: 3, bytes: Buffer.byteLength(expected) }
    },
  }
  const performance = new BrowserPerformanceOrchestrator({
    getLivePageDriverSession: async () => ({ driver }),
  } as never)
  const capture = () =>
    performance.captureHeapSnapshot(
      'heap-session',
      { workspaceRoot: root, url: 'https://example.test/' },
      { path: name },
      controller.signal
    )
  try {
    const result = await capture()
    assert.equal(result.url, driver.getURL())
    assert.equal(result.bytes, Buffer.byteLength(expected))
    assert.equal(await readFile(target, 'utf8'), expected)
    assert.deepEqual(await readdir(root), [name])

    await writeFile(target, 'original')
    mode = 'cancel'
    let settled = false
    inFlight = capture().finally(() => {
      settled = true
    })
    const cancelled = assert.rejects(inFlight, (error) => error === cancelReason)
    await entered.promise
    assert.equal(settled, false)
    assert.equal(await readFile(target, 'utf8'), 'original')
    release.resolve()
    await cancelled
    assert.equal(await readFile(target, 'utf8'), 'original')
    assert.deepEqual(await readdir(root), [name])

    controller = new AbortController()
    mode = 'failure'
    await assert.rejects(capture(), (error) => error === driverFailure)
    assert.equal(await readFile(target, 'utf8'), 'original')
    assert.deepEqual(await readdir(root), [name])

    mode = 'success'
    const retried = await capture()
    assert.equal(retried.bytes, Buffer.byteLength(expected))
    assert.equal(await readFile(target, 'utf8'), expected)
    assert.deepEqual(await readdir(root), [name])
  } finally {
    release.resolve()
    await inFlight?.catch(() => undefined)
    performance.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
