import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { KernelArtifactExtractor } from '../../../src/contract/requires'
import { KernelUpdater } from '../../../src/impl/updater/KernelUpdater'
import { PassthroughKernelArtifactExtractor } from '../../../src/impl/updater/PassthroughKernelArtifactExtractor'
import type { KernelUpdaterOptions } from '../../../src/types/updater'
import { KernelUpdaterError } from '../../../src/utils/errors'
import { readKernelActivePointer } from '../../../src/utils/updater/pointer'

import {
  artifactOf,
  createFakeFetch,
  createTemporaryDirectories,
  type FakeFetchOptions,
  manifestOf,
} from './support'

const directories = createTemporaryDirectories('install')

afterEach(async () => {
  await directories.cleanup()
})

const ManifestUrl = 'https://updates.example.com/kernel.json'
const first = artifactOf('https://cdn.example.com/kernel-1.0.0.bin', 'kernel-1.0.0')
const second = artifactOf('https://cdn.example.com/kernel-1.1.0.bin', 'kernel-1.1.0')
const third = artifactOf('https://cdn.example.com/kernel-1.2.0.bin', 'kernel-1.2.0')

const manifest = manifestOf([
  { version: '1.0.0', artifacts: { 'linux-x64': first.descriptor } },
  { version: '1.1.0', artifacts: { 'linux-x64': second.descriptor } },
  { version: '1.2.0', artifacts: { 'linux-x64': third.descriptor } },
])

function resources(): Record<string, Uint8Array | string> {
  return {
    [ManifestUrl]: JSON.stringify(manifest),
    [first.descriptor.url]: first.bytes,
    [second.descriptor.url]: second.bytes,
    [third.descriptor.url]: third.bytes,
  }
}

function createUpdater(
  root: string,
  overrides: Partial<KernelUpdaterOptions> = {},
  fetchOptions: FakeFetchOptions = {}
): KernelUpdater {
  return new KernelUpdater({
    root,
    target: 'linux-x64',
    manifestSource: ManifestUrl,
    fetch: createFakeFetch(resources(), fetchOptions),
    ...overrides,
  })
}

async function payloadOf(root: string, version: string): Promise<string> {
  return readFile(join(root, 'versions', version, `kernel-${version}.bin`), 'utf8')
}

function observeInstallation(root: string) {
  const requested: string[] = []
  const extracted: string[] = []
  const extractor = new PassthroughKernelArtifactExtractor()
  const updater = createUpdater(
    root,
    {
      extractor: {
        async extract(context) {
          extracted.push(context.version)
          await extractor.extract(context)
        },
      },
    },
    { onRequest: (url) => requested.push(url) }
  )
  return { updater, requested, extracted }
}

async function replaceInstallRecord(
  root: string,
  version: string,
  contents: string | undefined
): Promise<void> {
  const path = join(root, 'versions', version, '.kernel-install.json')
  if (contents === undefined) await rm(path)
  else await writeFile(path, contents, 'utf8')
}

describe('Kernel side-by-side installation', () => {
  test('installs versions side by side without touching each other', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)

    const installed = await updater.ensureInstalled('1.0.0')
    expect(installed).toMatchObject({
      version: '1.0.0',
      installed: true,
      path: join(root, 'versions', '1.0.0'),
      record: { sha256: first.descriptor.sha256, target: 'linux-x64', format: 'raw' },
    })
    await updater.ensureInstalled('1.1.0')

    expect((await readdir(join(root, 'versions'))).sort()).toEqual(['1.0.0', '1.1.0'])
    expect(await payloadOf(root, '1.0.0')).toBe('kernel-1.0.0')
    expect(await payloadOf(root, '1.1.0')).toBe('kernel-1.1.0')
    expect((await readdir(root)).sort()).toEqual([
      '.staging',
      'backups',
      'data',
      'runtime',
      'versions',
    ])
  })

  test('treats an already installed version as satisfied', async () => {
    const root = await directories.create()
    const requested: string[] = []
    const updater = createUpdater(
      root,
      {},
      {
        onRequest: (url) => requested.push(url),
      }
    )

    await updater.ensureInstalled('1.0.0')
    const repeat = await updater.ensureInstalled('1.0.0')

    expect(repeat.installed).toBe(false)
    expect(repeat.record.sha256).toBe(first.descriptor.sha256)
    expect(requested).toEqual([ManifestUrl, first.descriptor.url])
  })

  test('reports installed versions with their active and completeness state', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.ensureInstalled('1.1.0')
    await updater.activateVersion('1.1.0')
    await mkdir(join(root, 'versions', '1.3.0'), { recursive: true })
    await mkdir(join(root, 'versions', 'not-a-version'), { recursive: true })

    expect(await updater.listInstalledVersions()).toMatchObject([
      { version: '1.0.0', active: false, complete: true },
      { version: '1.1.0', active: true, complete: true },
      { version: '1.3.0', active: false, complete: false },
    ])
  })

  test('leaves installed versions and the pointer intact when a download aborts', async () => {
    const root = await directories.create()
    await createUpdater(root).ensureInstalled('1.0.0')
    await createUpdater(root).activateVersion('1.0.0')
    const pointerBefore = await readFile(join(root, 'current.json'), 'utf8')

    const interrupted = createUpdater(
      root,
      {},
      {
        interruptAfterBytes: 8,
        interruptUrls: [second.descriptor.url],
      }
    )
    await expect(interrupted.ensureInstalled('1.1.0')).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
    })

    expect(await readdir(join(root, 'versions'))).toEqual(['1.0.0'])
    expect(await payloadOf(root, '1.0.0')).toBe('kernel-1.0.0')
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect(await readdir(join(root, '.staging'))).toEqual([])
  })

  test('leaves nothing behind when staging fails midway through an install', async () => {
    const root = await directories.create()
    await createUpdater(root).ensureInstalled('1.0.0')
    await createUpdater(root).activateVersion('1.0.0')

    const failingExtractor: KernelArtifactExtractor = {
      async extract(context) {
        await writeFile(join(context.destinationDirectory, 'partial'), 'x', 'utf8')
        throw new Error('archive is truncated')
      },
    }
    const updater = createUpdater(root, { extractor: failingExtractor })

    await expect(updater.ensureInstalled('1.1.0')).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      details: { version: '1.1.0' },
    })
    expect(await readdir(join(root, 'versions'))).toEqual(['1.0.0'])
    expect((await readKernelActivePointer(join(root, 'current.json')))?.version).toBe('1.0.0')
    expect(await readdir(join(root, '.staging'))).toEqual([])
  })

  test('discards a staging directory orphaned by an earlier crash', async () => {
    const root = await directories.create()
    const orphan = join(root, '.staging', '1.1.0-crashed')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'partial'), 'x', 'utf8')

    await createUpdater(root).ensureInstalled('1.0.0')

    expect(await readdir(join(root, '.staging'))).toEqual([])
    expect(await readdir(join(root, 'versions'))).toEqual(['1.0.0'])
  })

  test('replaces a version directory that never completed an install', async () => {
    const root = await directories.create()
    const partial = join(root, 'versions', '1.0.0')
    await mkdir(partial, { recursive: true })
    await writeFile(join(partial, 'leftover'), 'junk', 'utf8')

    const outcome = await createUpdater(root).ensureInstalled('1.0.0')

    expect(outcome.installed).toBe(true)
    expect((await readdir(partial)).sort()).toEqual(['.kernel-install.json', 'kernel-1.0.0.bin'])
  })

  test('refuses to reinstall over the active version', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)
    await updater.ensureInstalled('1.0.0')
    await updater.activateVersion('1.0.0')
    const pointerBefore = await readFile(join(root, 'current.json'))
    const recordPath = join(root, 'versions', '1.0.0', '.kernel-install.json')
    const recordBefore = await readFile(recordPath)
    const observed = observeInstallation(root)

    await expect(observed.updater.ensureInstalled('1.0.0', { force: true })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      details: { version: '1.0.0' },
    })
    expect(await payloadOf(root, '1.0.0')).toBe('kernel-1.0.0')
    expect(await readFile(join(root, 'current.json'))).toEqual(pointerBefore)
    expect(await readFile(recordPath)).toEqual(recordBefore)
    expect(observed.requested).toEqual([])
    expect(observed.extracted).toEqual([])
    expect(await readdir(join(root, '.staging'))).toEqual([])
    await expect(stat(join(root, 'update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  for (const pointerState of ['valid', 'malformed JSON']) {
    test(`reuses a complete installation with a ${pointerState} pointer without writing`, async () => {
      const root = await directories.create()
      const updater = createUpdater(root)
      const installed = await updater.ensureInstalled('1.0.0')
      await updater.activateVersion('1.0.0')
      if (pointerState === 'malformed JSON') {
        await writeFile(join(root, 'current.json'), '{"schemaVersion":', 'utf8')
      }
      const pointerBefore = await readFile(join(root, 'current.json'))
      const recordPath = join(root, 'versions', '1.0.0', '.kernel-install.json')
      const recordBefore = await readFile(recordPath)
      const observed = observeInstallation(root)

      const repeated = await observed.updater.ensureInstalled('1.0.0')

      expect(repeated).toEqual({ ...installed, installed: false })
      expect(await payloadOf(root, '1.0.0')).toBe('kernel-1.0.0')
      expect(await readFile(join(root, 'current.json'))).toEqual(pointerBefore)
      expect(await readFile(recordPath)).toEqual(recordBefore)
      expect(observed.requested).toEqual([])
      expect(observed.extracted).toEqual([])
      expect(await readdir(join(root, '.staging'))).toEqual([])
      await expect(stat(join(root, 'update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  for (const { state, contents } of [
    { state: 'missing', contents: undefined },
    { state: 'malformed JSON', contents: '{"schemaVersion":' },
    { state: 'invalid schema', contents: '{"schemaVersion":2}' },
  ]) {
    for (const force of [false, true]) {
      test(`protects the active version with a ${state} record (force=${force})`, async () => {
        const root = await directories.create()
        const updater = createUpdater(root)
        await updater.ensureInstalled('1.0.0')
        await updater.activateVersion('1.0.0')
        const pointerBefore = await readFile(join(root, 'current.json'))
        const payloadPath = join(root, 'versions', '1.0.0', 'kernel-1.0.0.bin')
        const payloadBefore = await readFile(payloadPath)
        await replaceInstallRecord(root, '1.0.0', contents)
        const orphan = join(root, '.staging', 'protected-orphan')
        await mkdir(orphan)
        await writeFile(join(orphan, 'partial'), 'preserve staging', 'utf8')
        const observed = observeInstallation(root)

        await expect(observed.updater.ensureInstalled('1.0.0', { force })).rejects.toMatchObject({
          code: 'INSTALL_FAILED',
          details: { version: '1.0.0', path: join(root, 'versions', '1.0.0') },
        })

        expect(await readFile(payloadPath)).toEqual(payloadBefore)
        expect(await readFile(join(root, 'current.json'))).toEqual(pointerBefore)
        const recordPath = join(root, 'versions', '1.0.0', '.kernel-install.json')
        if (contents === undefined) {
          await expect(stat(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          expect(await readFile(recordPath, 'utf8')).toBe(contents)
        }
        expect(observed.requested).toEqual([])
        expect(observed.extracted).toEqual([])
        expect(await readdir(join(root, '.staging'))).toEqual(['protected-orphan'])
        expect(await readFile(join(orphan, 'partial'), 'utf8')).toBe('preserve staging')
        await expect(stat(join(root, 'update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
      })
    }

    test(`repairs an inactive installation with a ${state} record`, async () => {
      const root = await directories.create()
      const updater = createUpdater(root)
      await updater.ensureInstalled('1.0.0')
      await updater.ensureInstalled('1.1.0')
      await updater.activateVersion('1.1.0')
      const pointerBefore = await readFile(join(root, 'current.json'))
      const activePayloadPath = join(root, 'versions', '1.1.0', 'kernel-1.1.0.bin')
      const activePayloadBefore = await readFile(activePayloadPath)
      await replaceInstallRecord(root, '1.0.0', contents)
      await writeFile(join(root, 'versions', '1.0.0', 'kernel-1.0.0.bin'), 'incomplete', 'utf8')
      const observed = observeInstallation(root)

      const repaired = await observed.updater.ensureInstalled('1.0.0')

      expect(repaired).toMatchObject({ installed: true, record: { version: '1.0.0' } })
      expect(await payloadOf(root, '1.0.0')).toBe('kernel-1.0.0')
      expect(
        JSON.parse(await readFile(join(root, 'versions', '1.0.0', '.kernel-install.json'), 'utf8'))
      ).toEqual(repaired.record)
      expect(await readFile(activePayloadPath)).toEqual(activePayloadBefore)
      expect(await readFile(join(root, 'current.json'))).toEqual(pointerBefore)
      expect(observed.requested).toEqual([ManifestUrl, first.descriptor.url])
      expect(observed.extracted).toEqual(['1.0.0'])
      expect(await readdir(join(root, '.staging'))).toEqual([])
      await expect(stat(join(root, 'update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  for (const { state, contents } of [
    { state: 'malformed JSON', contents: '{"schemaVersion":' },
    { state: 'invalid schema', contents: '{"schemaVersion":2}' },
  ]) {
    test(`refuses to repair an installation when the active pointer has ${state}`, async () => {
      const root = await directories.create()
      const updater = createUpdater(root)
      await updater.ensureInstalled('1.0.0')
      const payloadPath = join(root, 'versions', '1.0.0', 'kernel-1.0.0.bin')
      const payloadBefore = await readFile(payloadPath)
      await replaceInstallRecord(root, '1.0.0', undefined)
      await writeFile(join(root, 'current.json'), contents, 'utf8')
      const orphan = join(root, '.staging', 'protected-orphan')
      await mkdir(orphan)
      await writeFile(join(orphan, 'partial'), 'preserve staging', 'utf8')
      const observed = observeInstallation(root)

      await expect(observed.updater.ensureInstalled('1.0.0')).rejects.toMatchObject({
        code: 'INVALID_POINTER',
      })

      expect(await readFile(payloadPath)).toEqual(payloadBefore)
      expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(contents)
      await expect(
        stat(join(root, 'versions', '1.0.0', '.kernel-install.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(observed.requested).toEqual([])
      expect(observed.extracted).toEqual([])
      expect(await readdir(join(root, '.staging'))).toEqual(['protected-orphan'])
      expect(await readFile(join(orphan, 'partial'), 'utf8')).toBe('preserve staging')
      await expect(stat(join(root, 'update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  test('rejects an unsigned artifact when signatures are required', async () => {
    const root = await directories.create()
    const updater = createUpdater(root, { requireSignature: true })

    await expect(updater.ensureInstalled('1.0.0')).rejects.toMatchObject({
      code: 'SIGNATURE_REJECTED',
      details: { version: '1.0.0', target: 'linux-x64' },
    })
    expect(await readdir(join(root, 'versions'))).toEqual([])
    expect(await readdir(join(root, '.staging'))).toEqual([])
  })

  test('accepts an artifact once an injected verifier trusts it', async () => {
    const root = await directories.create()
    const seen: string[] = []
    const updater = createUpdater(root, {
      requireSignature: true,
      signatureVerifier: {
        verify(context) {
          seen.push(`${context.version}:${context.sha256}`)
          return Promise.resolve({ verified: true, method: 'test-ed25519' })
        },
      },
    })

    await updater.ensureInstalled('1.0.0')

    expect(seen).toEqual([`1.0.0:${first.descriptor.sha256}`])
    expect(await payloadOf(root, '1.0.0')).toBe('kernel-1.0.0')
  })

  test('refuses to update while another process holds the lock', async () => {
    const root = await directories.create()
    await createUpdater(root).ensureInstalled('1.0.0')
    await writeFile(
      join(root, 'update.lock'),
      JSON.stringify({ holderId: 'other', pid: process.pid, acquiredAt: 1 }),
      { encoding: 'utf8', mode: 0o600 }
    )

    const contender = createUpdater(root)
    const contention = contender.ensureInstalled('1.1.0')
    await expect(contention).rejects.toBeInstanceOf(KernelUpdaterError)
    await expect(contention).rejects.toMatchObject({
      code: 'UPDATE_LOCK_HELD',
      details: { ownerPid: process.pid },
    })

    expect(await readdir(join(root, 'versions'))).toEqual(['1.0.0'])
    expect(JSON.parse(await readFile(join(root, 'update.lock'), 'utf8'))).toMatchObject({
      holderId: 'other',
    })
  })

  test('serialises concurrent operations issued by one updater', async () => {
    const root = await directories.create()
    const updater = createUpdater(root)

    const outcomes = await Promise.all([
      updater.ensureInstalled('1.0.0'),
      updater.ensureInstalled('1.1.0'),
      updater.ensureInstalled('1.2.0'),
    ])

    expect(outcomes.map((outcome) => outcome.installed)).toEqual([true, true, true])
    expect((await readdir(join(root, 'versions'))).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0'])
    await expect(stat(join(root, 'update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
