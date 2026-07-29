import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { KernelModStore, registerSystemModPacks } from '../src/daemon/mod-store'
import {
  buildDefaultSystemPackRecords,
  maybeRegisterDefaultSystemPacks,
  resolveKernelPacksDirectory,
} from '../src/daemon/system-packs'

function emptyStore(): KernelModStore {
  return new KernelModStore({
    userModsDirectory: join(tmpdir(), 'velaros-system-packs-test-mods'),
  })
}

describe('system packs', () => {
  test('ships required pack entry files next to the Kernel', async () => {
    const packsDirectory = resolveKernelPacksDirectory()
    const records = await buildDefaultSystemPackRecords(packsDirectory)
    const ids = records.map((record) => record.id)
    expect(ids).toContain('system.agent')
    expect(ids).toContain('system.model')
    expect(ids).toContain('system.workspace')
    expect(ids).toContain('system.browser')
    for (const record of records) {
      await access(record.specifier)
    }
    await access(join(packsDirectory, 'pack-resolve.mjs'))
  })

  test('registers first-time system packs enabled', () => {
    const store = emptyStore()
    registerSystemModPacks(store, [
      {
        id: 'system.computer',
        version: '1.0.0',
        specifier: '/packs/computer.entry.mjs',
        provides: ['velaros.computer'],
      },
    ])
    expect(store.get('system.computer')?.enabled).toBe(true)
  })

  test('keeps a persisted disabled system pack disabled while refreshing metadata', () => {
    const store = emptyStore()
    // Shape of what loadModIndexIntoStore() restores from mod-index.json.
    store.register({
      id: 'system.computer',
      kind: 'system',
      version: '0.9.0',
      specifier: '/old/computer.entry.mjs',
      enabled: false,
      provides: ['velaros.computer'],
    })

    registerSystemModPacks(store, [
      {
        id: 'system.computer',
        version: '1.0.0',
        specifier: '/new/computer.entry.mjs',
        provides: ['velaros.computer'],
      },
    ])

    const pack = store.get('system.computer')
    expect(pack?.enabled).toBe(false)
    expect(pack?.version).toBe('1.0.0')
    expect(pack?.specifier).toBe('/new/computer.entry.mjs')
    expect(store.listEnabled()).toHaveLength(0)
  })

  test('lets an explicit enabled flag override the stored state', () => {
    const store = emptyStore()
    store.register({
      id: 'system.computer',
      kind: 'system',
      version: '1.0.0',
      specifier: '/packs/computer.entry.mjs',
      enabled: false,
      provides: ['velaros.computer'],
    })

    registerSystemModPacks(store, [
      {
        id: 'system.computer',
        version: '1.0.0',
        specifier: '/packs/computer.entry.mjs',
        provides: ['velaros.computer'],
        enabled: true,
      },
    ])
    expect(store.get('system.computer')?.enabled).toBe(true)
  })

  test('auto-registration does not resurrect a user-disabled default pack', async () => {
    const store = emptyStore()
    store.register({
      id: 'system.workspace',
      kind: 'system',
      version: '0.0.1',
      specifier: '/stale/workspace.entry.mjs',
      enabled: false,
      provides: ['velaros.workspace'],
    })

    const records = await maybeRegisterDefaultSystemPacks(store)

    expect(store.get('system.workspace')?.enabled).toBe(false)
    expect(store.get('system.workspace')?.specifier)
      .toBe(join(resolveKernelPacksDirectory(), 'workspace.entry.mjs'))
    expect(store.get('system.agent')?.enabled).toBe(true)
    expect(records.find((record) => record.id === 'system.workspace')?.enabled)
      .toBe(false)
  })
})
