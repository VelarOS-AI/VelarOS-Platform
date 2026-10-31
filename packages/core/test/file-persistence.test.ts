import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { expect, spyOn, test } from 'bun:test'

import { writeFileAtomically } from '../src/utils/FilePersistence'

async function removeScratch(dir: string): Promise<void> {
  const target = resolve(dir)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('velaros-atomic-'))
    throw new Error('Refusing to remove a directory outside this test allocation')
  await fs.rm(target, { recursive: true, force: true })
}

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
