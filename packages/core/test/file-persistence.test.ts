import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { expect, spyOn, test } from 'bun:test'

import { writeFileAtomically, writeFileOnce } from '../src/utils/FilePersistence'

async function removeScratch(dir: string): Promise<void> {
  const target = resolve(dir)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('velaros-atomic-'))
    throw new Error('Refusing to remove a directory outside this test allocation')
  await fs.rm(target, { recursive: true, force: true })
}

test('concurrent one-time writes publish exactly one complete value and never overwrite it', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-once-'))
  const file = join(dir, 'object.json')
  const values = Array.from({ length: 20 }, (_, index) => `${index}:${'payload'.repeat(1024)}`)
  try {
    const results = await Promise.all(values.map((value) => writeFileOnce(file, value)))
    expect(results.filter(Boolean)).toHaveLength(1)
    const published = await fs.readFile(file, 'utf8')
    expect(published).toBe(values[results.indexOf(true)])
    expect(await writeFileOnce(file, 'replacement')).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe(published)
    expect(await fs.readdir(dir)).toEqual(['object.json'])
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  } finally {
    await removeScratch(dir)
  }
})

test('one-time write failure removes its staging file without publishing a partial object', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-once-invalid-'))
  try {
    await expect(writeFileOnce(join(dir, 'object.json'), {} as Uint8Array)).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual([])
  } finally {
    await removeScratch(dir)
  }
})

test('one-time publication reports its actual failure and preserves an existing target', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-once-link-'))
  const file = join(dir, 'object.json')
  await fs.writeFile(file, 'prior')
  const failure = Object.assign(new Error('link unavailable'), { code: 'ENOSPC' })
  const link = spyOn(fs, 'link').mockRejectedValue(failure)
  try {
    await expect(writeFileOnce(file, 'replacement')).rejects.toBe(failure)
    expect(await fs.readFile(file, 'utf8')).toBe('prior')
    expect(await fs.readdir(dir)).toEqual(['object.json'])
  } finally {
    link.mockRestore()
    await removeScratch(dir)
  }
})

test('one-time writes close and clean staged bytes when the required file flush fails', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-once-flush-'))
  const originalOpen = fs.open
  const failure = Object.assign(new Error('flush unavailable'), { code: 'EIO' })
  let restoreSync: (() => void) | undefined
  const open = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    const sync = spyOn(handle, 'sync').mockRejectedValue(failure)
    restoreSync = () => sync.mockRestore()
    return handle
  })
  try {
    await expect(writeFileOnce(join(dir, 'object.json'), 'unpublished')).rejects.toBe(failure)
    expect(await fs.readdir(dir)).toEqual([])
  } finally {
    restoreSync?.()
    open.mockRestore()
    await removeScratch(dir)
  }
})

test.skipIf(process.platform !== 'win32')(
  'atomic rename tolerates transient Windows locks without removing the prior file',
  async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-retry-'))
    const file = join(dir, 'state.json')
    const originalRename = fs.rename
    let attempts = 0
    await fs.writeFile(file, 'prior')
    const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file && ++attempts < 3) {
        expect(await fs.readFile(file, 'utf8')).toBe('prior')
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      }
      await originalRename(from, to)
    })
    try {
      await writeFileAtomically(file, 'refreshed')
      expect(attempts).toBe(3)
      expect(await fs.readFile(file, 'utf8')).toBe('refreshed')
      expect(await fs.readdir(dir)).toEqual(['state.json'])
    } finally {
      rename.mockRestore()
      await removeScratch(dir)
    }
  }
)

test('failed atomic publication preserves the old file and removes only its staging file', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-failure-'))
  const file = join(dir, 'state.json')
  const originalRename = fs.rename
  let attempts = 0
  await fs.writeFile(file, 'prior')
  const failure = Object.assign(new Error('unavailable'), { code: 'ENOSPC' })
  const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === file) {
      attempts++
      throw failure
    }
    await originalRename(from, to)
  })
  try {
    await expect(writeFileAtomically(file, 'refreshed')).rejects.toBe(failure)
    expect(attempts).toBe(1)
    expect(await fs.readFile(file, 'utf8')).toBe('prior')
    expect(await fs.readdir(dir)).toEqual(['state.json'])
  } finally {
    rename.mockRestore()
    await removeScratch(dir)
  }
})

test.skipIf(process.platform !== 'win32')(
  'persistent Windows locks exhaust a bounded retry budget and preserve the previous value',
  async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'velaros-atomic-locked-'))
    const file = join(dir, 'state.json')
    const originalRename = fs.rename
    let attempts = 0
    await fs.writeFile(file, 'prior')
    const failure = Object.assign(new Error('locked'), { code: 'EBUSY' })
    const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file) {
        attempts++
        throw failure
      }
      await originalRename(from, to)
    })
    try {
      await expect(writeFileAtomically(file, 'refreshed')).rejects.toBe(failure)
      expect(attempts).toBe(5)
      expect(await fs.readFile(file, 'utf8')).toBe('prior')
      expect(await fs.readdir(dir)).toEqual(['state.json'])
    } finally {
      rename.mockRestore()
      await removeScratch(dir)
    }
  }
)
