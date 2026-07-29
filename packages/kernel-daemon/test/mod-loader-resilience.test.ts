import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { createDefaultKernelDaemonPaths } from '@velaros-ai/kernel-client/contracts'

import { bootKernelDaemon } from '../src/daemon/boot'
import { KernelModLoader } from '../src/daemon/mod-loader'
import { type KernelModPackRecord, KernelModStore } from '../src/daemon/mod-store'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-mod-loader-'))
  directories.push(directory)
  return directory
}

/** Pack entry that exports a usable module. */
async function writeHealthyPack(
  directory: string,
  fileName: string,
  moduleId: string,
  capabilityId: string,
): Promise<string> {
  const specifier = join(directory, fileName)
  await writeFile(
    specifier,
    `export default {
  manifest: {
    id: '${moduleId}',
    version: '1.0.0',
    apiVersion: 1,
    provides: [{ id: '${capabilityId}', version: '1.0.0' }],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate() {},
}
`,
  )
  return specifier
}

/** Pack entry that reproduces the sibling-dist failure: throws while importing. */
async function writeThrowingPack(
  directory: string,
  fileName: string,
): Promise<string> {
  const specifier = join(directory, fileName)
  await writeFile(
    specifier,
    `throw new Error('pack boom: sibling capability dist missing')\n`,
  )
  return specifier
}

function packRecord(
  id: string,
  specifier: string,
  provides: readonly string[],
): KernelModPackRecord {
  return {
    id,
    kind: 'system',
    version: '1.0.0',
    specifier,
    enabled: true,
    provides: [...provides],
  }
}

function captureErrorLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }
  return { lines, restore: () => { console.error = original } }
}

describe('mod loader resilience', () => {
  test('isolates a failing pack instead of failing the whole load', async () => {
    const directory = await temporaryDirectory()
    const healthy = await writeHealthyPack(
      directory,
      'healthy.entry.mjs',
      'module.healthy',
      'test.healthy',
    )
    const throwing = await writeThrowingPack(directory, 'boom.entry.mjs')
    const wrongShape = join(directory, 'shape.entry.mjs')
    await writeFile(wrongShape, 'export default { nope: true }\n')

    const store = new KernelModStore({
      userModsDirectory: join(directory, 'mods'),
    })
    store.register(packRecord('system.boom', throwing, ['test.boom']))
    store.register(packRecord('system.healthy', healthy, ['test.healthy']))
    store.register(packRecord('system.shape', wrongShape, ['test.shape']))

    const capture = captureErrorLog()
    let loaded
    try {
      loaded = await new KernelModLoader(store).loadEnabled()
    } finally {
      capture.restore()
    }

    expect(loaded.modules).toHaveLength(1)
    expect(loaded.modules[0]?.manifest.id).toBe('module.healthy')
    expect(loaded.packs.map((pack) => pack.id)).toEqual(['system.healthy'])

    const failureIds = loaded.failures.map((failure) => failure.id).sort()
    expect(failureIds).toEqual(['system.boom', 'system.shape'])
    expect(store.listLoadFailures()).toHaveLength(2)

    const boom = store.getLoadFailure('system.boom')
    expect(boom?.specifier).toBe(throwing)
    expect(boom?.reason).toContain('pack boom')
    expect(store.getLoadFailure('system.shape')?.reason)
      .toContain('not a KernelModuleDefinition')
    expect(store.getLoadFailure('system.healthy')).toBeUndefined()

    // 不静默:每个失败都留下可读日志。
    expect(capture.lines).toHaveLength(2)
    expect(capture.lines.some((line) => line.includes('system.boom')
      && line.includes('pack boom'))).toBe(true)

    // The pack stays enabled/visible — a load failure is not a silent uninstall.
    expect(store.listEnabled()).toHaveLength(3)
  })

  test('boots the daemon and serves the surviving capabilities', async () => {
    const directory = await temporaryDirectory()
    const healthy = await writeHealthyPack(
      directory,
      'healthy.entry.mjs',
      'module.healthy',
      'test.healthy',
    )
    const throwing = await writeThrowingPack(directory, 'boom.entry.mjs')

    const capture = captureErrorLog()
    let booted
    try {
      booted = await bootKernelDaemon({
        kernelVersion: '0.3.0-test',
        paths: createDefaultKernelDaemonPaths('mod-loader-kernel', directory),
        modStorePaths: { userModsDirectory: join(directory, 'mods') },
        modPacks: [
          packRecord('system.boom', throwing, ['test.boom']),
          packRecord('system.healthy', healthy, ['test.healthy']),
        ],
      })
    } finally {
      capture.restore()
    }

    try {
      const handshake = booted.service.handshake()
      expect(handshake.modules.map((module) => module.id)).toEqual(['module.healthy'])
      expect(booted.modLoadFailures.map((failure) => failure.id)).toEqual(['system.boom'])
      expect(booted.modStore.getLoadFailure('system.boom')?.reason).toContain('pack boom')
      // mods.list keeps reporting the pack as installed + enabled.
      expect(booted.modStore.list().map((pack) => pack.id).sort())
        .toEqual(['system.boom', 'system.healthy'])
      expect(capture.lines.some((line) => line.includes('system.boom'))).toBe(true)
    } finally {
      await booted.stop()
    }
  })
})
