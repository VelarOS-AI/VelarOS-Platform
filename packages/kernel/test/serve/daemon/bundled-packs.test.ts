import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { KernelModLoader, persistModIndex } from '../../../src/impl/serve/KernelModLoader'
import { KernelModStore, registerSystemModPacks } from '../../../src/impl/serve/KernelModStore'
import { defineKernelModule } from '../../../src/types/abi-module'
import {
  createBundledModPack,
  registerBundledPacks,
  toBundledPackRecords,
} from '../../../src/utils/serve/mod-packs'

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
  test('内核自己不带任何 bundled pack，宿主交来的模块 import 期就在手', () => {
    const records = toBundledPackRecords([
      createBundledModPack({ id: 'system.probe', module: probeModule }),
    ])
    expect(records.map((record) => record.specifier)).toEqual(['bundled:velaros.probe'])
    expect(records.every((record) => record.kind === 'system')).toBe(true)
    // 模块在 import 期就在手：没有路径、没有 dist、没有 IO。
    expect(typeof records[0]?.module?.activate).toBe('function')
  })

  test('loads a host-injected bundled capability pack without importing anything', async () => {
    const store = emptyStore()
    // Shape of what a host (Desktop / Workbench / VelarOS Terminal) injects for a
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
    expect(loaded.failures[0]?.reason).toContain('这次构建里已经没有它了')
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
