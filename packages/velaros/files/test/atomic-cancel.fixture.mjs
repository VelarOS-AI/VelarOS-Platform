import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2]
const directory = await mkdtemp(join(tmpdir(), 'files-atomic-cancel-'))
const target = join(directory, 'target.txt')
await writeFile(target, 'before')
const controller = new AbortController()
let cancelled = false
let targetAtCancel
const cancel = async () => {
  targetAtCancel = await readFile(target, 'utf8')
  cancelled = true
  controller.abort()
}
const open = fs.promises.open
const rename = fs.promises.rename
fs.promises.open = async (...args) => {
  const handle = await open(...args)
  if (mode === 'staged-write' && String(args[0]).includes('.velaros-write-')) {
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      await sync()
      await cancel()
    }
  }
  if (mode === 'checked-delete' && args[0] === target) {
    const close = handle.close.bind(handle)
    handle.close = async () => {
      await close()
      if (!cancelled) await cancel()
    }
  }
  return handle
}
fs.promises.rename = async (...args) => {
  await rename(...args)
  if (mode === 'after-rename' && args[1] === target) await cancel()
}
syncBuiltinESMExports()
try {
  const { createLocalFilePort } = await import('../../dist/files/impl/LocalFilePort.js')
  const port = createLocalFilePort({ resolvePath: (path) => path })
  let failure
  try {
    await port.commit(
      [
        {
          target,
          bytes: mode === 'checked-delete' ? null : Buffer.from('planned'),
          expected: { exists: true, bytes: Buffer.from('before') },
        },
      ],
      controller.signal
    )
  } catch (error) {
    failure = error
  }
  assert.equal(cancelled, true)
  if (mode === 'after-rename') {
    assert.equal(failure, undefined)
    assert.equal(targetAtCancel, 'planned')
    assert.equal(await readFile(target, 'utf8'), 'planned')
  } else {
    assert.ok(failure, 'cancellation before the target mutation must reject')
    assert.deepEqual(failure.context.applied, [])
    assert.equal(targetAtCancel, 'before')
    assert.equal(await readFile(target, 'utf8'), 'before')
  }
  assert.deepEqual(await readdir(directory), ['target.txt'])
  console.info(JSON.stringify({ mode, cancelled, targetAtCancel, success: true }))
} finally {
  fs.promises.open = open
  fs.promises.rename = rename
  syncBuiltinESMExports()
  await rm(directory, { recursive: true, force: true })
}
