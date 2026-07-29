import {
  readdir,
  readFile,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  type KernelHealthCheckContext,
  KernelUpdater,
  type KernelUpdaterOptions,
  parseKernelActivePointer,
  readKernelActivePointer,
} from '../../src/updater'

import {
  artifactOf,
  createFakeFetch,
  createTemporaryDirectories,
  manifestOf,
} from './support'

const directories = createTemporaryDirectories('activation')

afterEach(async () => {
  await directories.cleanup()
})

const ManifestUrl = 'https://updates.example.com/kernel.json'
const releases = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'].map((version) => ({
  version,
  artifact: artifactOf(`https://cdn.example.com/kernel-${version}.bin`, `kernel-${version}`),
}))

const manifest = manifestOf(releases.map((release) => ({
  version: release.version,
  artifacts: { 'linux-x64': release.artifact.descriptor },
})))

function resources(): Record<string, Uint8Array | string> {
  const map: Record<string, Uint8Array | string> = {
    [ManifestUrl]: JSON.stringify(manifest),
  }
  for (const release of releases) {
    map[release.artifact.descriptor.url] = release.artifact.bytes
  }
  return map
}

function createUpdater(
  root: string,
  overrides: Partial<KernelUpdaterOptions> = {},
): KernelUpdater {
  return new KernelUpdater({
    root,
    target: 'linux-x64',
    manifestSource: ManifestUrl,
    fetch: createFakeFetch(resources()),
    holderId: 'test-product',
    ...overrides,
  })
}

async function pointerOf(root: string): Promise<unknown> {
  return parseKernelActivePointer(
    JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as unknown,
  )
}

describe('Kernel activation pointer', () => {
  test('switches current.json atomically and records the rollback target', async () => {
    const root = await directories.create()
    const updater = createUpdater(root, { now: () => 1700000000000 })
    await updater.ensureInstalled('1.0.0')
    await updater.ensureInstalled('1.1.0')

    expect(await updater.getActivePointer()).toBeUndefined()
    expect(await updater.activateVersion('1.0.0')).toEqual({
      schemaVersion: 1,
      version: '1.0.0',
      previousVersion: null,
      updatedAt: 1700000000000,
      updatedBy: 'test-product',
    })
    expect(await updater.activateVersion('1.1.0')).toMatchObject({
      version: '1.1.0',
      previousVersion: '1.0.0',
    })

    expect(await pointerOf(root)).toMatchObject({
      version: '1.1.0',
      previousVersion: '1.0.0',
    })
    expect(await updater.getActiveVersion()).toBe('1.1.0')
    expect((await stat(join(root, 'current.json'))).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).filter((entry) => entry.includes('.tmp')))
      .toEqual([])
    expect((await readdir(join(root, 'backups'))).length).toBe(1)
  })

  test('refuses to activate a version that is not installed', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')

    await expect(updater.activateVersion('1.1.0')).rejects.toMatchObject({
      code: 'VERSION_NOT_INSTALLED',
      details: { version: '1.1.0' },
    })
    expect(await updater.getActiveVersion()).toBe('1.0.0')
  })

  test('reverts the pointer when the activation health check fails', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.ensureInstalled('1.1.0')
    await updater.activateVersion('1.0.0')
    const before = await updater.getActivePointer()

    const inspected: KernelHealthCheckContext[] = []
    await expect(updater.activateVersion('1.1.0', {
      healthCheck: (context) => {
        inspected.push(context)
        return false
      },
    })).rejects.toMatchObject({
      code: 'HEALTH_CHECK_FAILED',
      details: { version: '1.1.0', previousVersion: '1.0.0' },
    })

    expect(inspected).toMatchObject([
      {
        version: '1.1.0',
        path: join(root, 'versions', '1.1.0'),
        previousVersion: '1.0.0',
      },
    ])
    expect(await updater.getActiveVersion()).toBe('1.0.0')
    expect(await pointerOf(root)).toMatchObject({
      version: '1.0.0',
      previousVersion: before?.previousVersion ?? null,
    })
  })

  test('reverts a throwing health check and preserves its cause', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')
    await updater.ensureInstalled('1.1.0')

    const failure = await updater.activateVersion('1.1.0', {
      healthCheck: () => Promise.reject(new Error('handshake timed out')),
    }).catch((caught: unknown) => caught)

    expect(failure).toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect((failure as Error).cause)
      .toMatchObject({ message: 'handshake timed out' })
    expect(await updater.getActiveVersion()).toBe('1.0.0')
  })

  test('removes the pointer again when the first activation is unhealthy', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')

    await expect(updater.activateVersion('1.0.0', { healthCheck: () => false }))
      .rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })

    expect(await updater.getActivePointer()).toBeUndefined()
    await expect(stat(join(root, 'current.json'))).rejects
      .toMatchObject({ code: 'ENOENT' })
  })

  test('rolls back to the previously active version on request', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.ensureInstalled('1.1.0')
    await updater.activateVersion('1.0.0')
    await updater.activateVersion('1.1.0')

    expect(await updater.rollback()).toMatchObject({
      version: '1.0.0',
      previousVersion: '1.1.0',
    })
    expect(await updater.getActiveVersion()).toBe('1.0.0')
  })

  test('reports a missing rollback target instead of guessing', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)

    await expect(updater.rollback()).rejects.toMatchObject({
      code: 'NO_ROLLBACK_TARGET',
    })
    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')
    await expect(updater.rollback()).rejects.toMatchObject({
      code: 'NO_ROLLBACK_TARGET',
      details: { version: '1.0.0' },
    })
  })
})

describe('Kernel compatibility resolution', () => {
  test('keeps the running version when it already satisfies the requirement', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.1.0')
    await updater.activateVersion('1.1.0')

    expect(await updater.ensureCompatible('^1.0.0')).toMatchObject({
      version: '1.1.0',
      installed: false,
      activated: false,
    })
  })

  test('activates the newest acceptable local install before downloading', async () => {
    const root = await directories.create()
    const requested: string[] = []
    const updater = createUpdater(root, {
      fetch: createFakeFetch(resources(), {
        onRequest: (url) => requested.push(url),
      }),
    })
    await updater.ensureInstalled('1.0.0')
    await updater.ensureInstalled('1.1.0')
    await updater.activateVersion('1.0.0')
    requested.length = 0

    expect(await updater.ensureCompatible('>=1.1.0')).toMatchObject({
      version: '1.1.0',
      installed: false,
      activated: true,
    })
    expect(requested).toEqual([])
  })

  test('installs and activates the newest published match when nothing local fits', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')

    expect(await updater.ensureCompatible({ range: '>=1.2.0 <2.0.0' })).toMatchObject({
      version: '1.2.0',
      installed: true,
      activated: true,
      pointer: { version: '1.2.0', previousVersion: '1.0.0' },
    })
    expect((await readdir(join(root, 'versions'))).sort())
      .toEqual(['1.0.0', '1.2.0'])
  })

  test('rolls the pointer back when the upgraded Kernel is unhealthy', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')

    await expect(updater.ensureCompatible({
      range: '>=1.2.0 <2.0.0',
      healthCheck: (context) => context.version === '1.0.0',
    })).rejects.toMatchObject({
      code: 'HEALTH_CHECK_FAILED',
      details: { version: '1.2.0', previousVersion: '1.0.0' },
    })

    expect(await updater.getActiveVersion()).toBe('1.0.0')
    expect((await readdir(join(root, 'versions'))).sort())
      .toEqual(['1.0.0', '1.2.0'])
  })

  test('refuses to download when installation is not permitted', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')

    await expect(updater.ensureCompatible({
      range: '^2.0.0',
      allowInstall: false,
    })).rejects.toMatchObject({
      code: 'VERSION_UNAVAILABLE',
      details: { versionRange: '^2.0.0' },
    })
  })

  test('reports when no published version satisfies the requirement', async () => {
    const root = await directories.create()

    await expect(createUpdater(root).ensureCompatible('^3.0.0')).rejects
      .toMatchObject({
        code: 'VERSION_UNAVAILABLE',
        details: { versionRange: '^3.0.0', target: 'linux-x64' },
      })
  })
})

describe('Kernel version retention', () => {
  test('prunes old installs but never the active or rollback version', async () => {
    const root = await directories.create()
    const updater = createUpdater(root, { retainedVersions: 2 })
    for (const release of releases) {
      await updater.ensureInstalled(release.version)
    }
    await updater.activateVersion('1.1.0')
    await updater.activateVersion('2.0.0')

    expect(await updater.pruneVersions()).toEqual(['1.0.0', '1.2.0'])
    expect((await readdir(join(root, 'versions'))).sort())
      .toEqual(['1.1.0', '2.0.0'])
    expect((await readKernelActivePointer(join(root, 'current.json'))))
      .toMatchObject({ version: '2.0.0', previousVersion: '1.1.0' })
  })

  test('honours a per-call retention count', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    for (const release of releases) {
      await updater.ensureInstalled(release.version)
    }

    expect(await updater.pruneVersions({ retain: 3 })).toEqual(['1.0.0'])
    expect((await readdir(join(root, 'versions'))).sort())
      .toEqual(['1.1.0', '1.2.0', '2.0.0'])
  })
})
