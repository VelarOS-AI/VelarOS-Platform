import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { defineKernelModule } from '@velaros-ai/core/kernel/abi'

import {
  BundledKernelPacks,
  createBundledModPack,
  registerBundledPacks,
  toBundledPackRecords,
} from '../../src/daemon/daemon/bundled-packs'
import { KernelModLoader, persistModIndex } from '../../src/daemon/daemon/mod-loader'
import { KernelModStore, registerSystemModPacks } from '../../src/daemon/daemon/mod-store'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-bundled-packs-'))
  directories.push(directory)
  return directory
}

function emptyStore(): KernelModStore {
  return new KernelModStore({
    userModsDirectory: join(tmpdir(), 'velaros-bundled-packs-test-mods'),
  })
}

const probeModule = defineKernelModule({
  manifest: {
    id: 'velaros.probe',
    version: '2.1.0',
    apiVersion: 1,
    provides: [{ id: 'velaros.probe', version: '2.1.0' }],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate() {},
})

describe('bundled packs', () => {
  test('ships the sidecar catalog as a compile-time constant, not disk entries', () => {
    const ids = BundledKernelPacks.map((pack) => pack.id)
    expect(ids).toEqual(['system.agent', 'system.model', 'system.browser'])
    for (const pack of BundledKernelPacks) {
      // The module is in hand at import time: no path, no dist, no IO.
      expect(typeof pack.module.activate).toBe('function')
      expect(pack.module.manifest.isolation).toBe('sidecar')
    }
  })

  test('records carry the bundled identity URI instead of a path', () => {
    const records = toBundledPackRecords()
    expect(records.map((record) => record.specifier)).toEqual([
      'bundled:velaros.agent.sidecar',
      'bundled:velaros.model.sidecar',
      'bundled:velaros.browser.sidecar',
    ])
    expect(records.every((record) => record.kind === 'system')).toBe(true)
  })

  test('loads a host-injected bundled capability pack without importing anything', async () => {
    const store = emptyStore()
    // Shape of what a host (Desktop / Workbench / velaros serve) injects for a
    // capability it compiled in.
    const pack = createBundledModPack({ id: 'system.probe', module: probeModule })
    expect(pack.version).toBe('2.1.0')
    expect(pack.provides).toEqual(['velaros.probe'])

    registerBundledPacks(store, [pack])
    const loaded = await new KernelModLoader(store).loadEnabled()

    expect(loaded.failures).toHaveLength(0)
    expect(loaded.modules).toEqual([probeModule])
  })

  test('reports an orphaned bundled pack instead of importing its identity URI', async () => {
    const store = emptyStore()
    // A persisted index entry whose build no longer compiles the pack in.
    store.register({
      id: 'system.gone',
      kind: 'system',
      version: '1.0.0',
      specifier: 'bundled:velaros.gone',
      enabled: true,
      provides: ['velaros.gone'],
    })

    const loaded = await new KernelModLoader(store).loadEnabled()

    expect(loaded.modules).toHaveLength(0)
    expect(loaded.failures[0]?.reason).toContain('no longer compiled')
  })

  test('registers first-time bundled packs enabled', () => {
    const store = emptyStore()
    registerBundledPacks(store, [
      createBundledModPack({ id: 'system.probe', module: probeModule }),
    ])
    expect(store.get('system.probe')?.enabled).toBe(true)
  })

  test('keeps a persisted disabled system pack disabled while refreshing metadata', () => {
    const store = emptyStore()
    // Shape of what loadModIndexIntoStore() restores from mod-index.json.
    store.register({
      id: 'system.probe',
      kind: 'system',
      version: '0.9.0',
      specifier: 'bundled:velaros.probe',
      enabled: false,
      provides: ['velaros.probe'],
    })

    registerBundledPacks(store, [
      createBundledModPack({ id: 'system.probe', module: probeModule }),
    ])

    const pack = store.get('system.probe')
    expect(pack?.enabled).toBe(false)
    expect(pack?.version).toBe('2.1.0')
    expect(store.listEnabled()).toHaveLength(0)
  })

  test('lets an explicit enabled flag override the stored state', () => {
    const store = emptyStore()
    store.register({
      id: 'system.probe',
      kind: 'system',
      version: '2.1.0',
      specifier: 'bundled:velaros.probe',
      enabled: false,
      provides: ['velaros.probe'],
    })

    registerSystemModPacks(store, [
      {
        id: 'system.probe',
        version: '2.1.0',
        specifier: 'bundled:velaros.probe',
        provides: ['velaros.probe'],
        module: probeModule,
        enabled: true,
      },
    ])
    expect(store.get('system.probe')?.enabled).toBe(true)
  })

  test('auto-registration does not resurrect a user-disabled bundled pack', () => {
    const store = emptyStore()
    store.register({
      id: 'system.agent',
      kind: 'system',
      version: '0.0.1',
      specifier: 'bundled:velaros.agent.sidecar',
      enabled: false,
      provides: ['velaros.agent'],
    })

    const records = registerBundledPacks(store)

    expect(store.get('system.agent')?.enabled).toBe(false)
    expect(store.get('system.model')?.enabled).toBe(true)
    expect(records.find((record) => record.id === 'system.agent')?.enabled).toBe(false)
  })

  test('persists the enabled bit but never the live module object', async () => {
    const indexPath = join(await temporaryDirectory(), 'mod-index.json')
    const store = new KernelModStore({
      userModsDirectory: join(tmpdir(), 'velaros-bundled-packs-test-mods'),
      indexPath,
    })
    registerBundledPacks(store, [
      createBundledModPack({ id: 'system.probe', module: probeModule }),
    ])
    store.disable('system.probe')

    await persistModIndex(store)
    const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as {
      packs: Array<Record<string, unknown>>
    }

    expect(persisted.packs[0]?.enabled).toBe(false)
    expect(persisted.packs[0]?.specifier).toBe('bundled:velaros.probe')
    expect(persisted.packs[0]).not.toHaveProperty('module')
  })
})
