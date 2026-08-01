import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { VelarHostConfigStore } from '../src/config'

describe('Velar Host config authority', () => {
  let temporaryRoot: string | undefined

  afterEach(async () => {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('creates a fail-closed persistent default', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const path = join(temporaryRoot, 'host-config.json')
    const store = await VelarHostConfigStore.open(path)

    expect(store.snapshot().value.capabilities).toEqual({
      workspace: { read: true, write: false },
      system: { observe: false, read: false, write: false, execute: false },
      computer: { observe: false, control: false },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(2)
  })

  test('migrates existing v1 config without broadening authority', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const path = join(temporaryRoot, 'host-config.json')
    await Bun.write(path, JSON.stringify({
      schemaVersion: 1,
      capabilities: {
        workspace: { read: true, write: true },
        computer: { observe: true, control: false },
      },
      computer: { resourceRoots: [] },
    }))

    const store = await VelarHostConfigStore.open(path)
    expect(store.snapshot().value).toMatchObject({
      schemaVersion: 2,
      capabilities: {
        workspace: { read: true, write: true },
        system: { observe: false, read: false, write: false, execute: false },
        computer: { observe: true, control: false },
      },
    })
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(2)
  })

  test('requires explicit confirmation before broadening dangerous capabilities', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const store = await VelarHostConfigStore.open(join(temporaryRoot, 'host-config.json'))
    const value = {
      capabilities: {
        workspace: { read: true, write: false },
        system: { observe: false, read: false, write: false, execute: false },
        computer: { observe: true, control: true },
      },
      computer: { resourceRoots: ['/opt/velaros/computer'] },
    }

    await expect(store.update({ ...value, confirmations: [] }))
      .rejects.toThrow('computer-observe, computer-control')
    const updated = await store.update({
      ...value,
      confirmations: ['computer-observe', 'computer-control'],
    })
    expect(updated.value.capabilities.computer).toEqual({ observe: true, control: true })
    expect(updated.value.computer.resourceRoots).toEqual(['/opt/velaros/computer'])
  })

  test('rejects unsafe dependent capability combinations', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-config-'))
    const store = await VelarHostConfigStore.open(join(temporaryRoot, 'host-config.json'))

    await expect(store.update({
      capabilities: {
        workspace: { read: false, write: true },
        system: { observe: false, read: false, write: false, execute: false },
        computer: { observe: false, control: false },
      },
      computer: { resourceRoots: [] },
      confirmations: ['workspace-write'],
    })).rejects.toThrow('requires workspace read')
  })
})
