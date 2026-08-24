import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import { AppError } from '@velaros-ai/core/error'

import { VelarModArchiveImporter } from '../src'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('VelarModArchiveImporter', () => {
  test('binds explicit trust and declared permissions to one rescanned archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velarmod-import-'))
    roots.push(root)
    const archive = join(root, 'review.velarmod')
    await writeArchive(archive, createManifest('1.0.0', ['fs:read']))
    const importer = createImporter()

    const report = await importer.scan(archive)

    expect(report).toMatchObject({
      mod: { id: 'review-kit', version: '1.0.0' },
      trust: { kind: 'user-imported' },
      installable: true,
    })
    try {
      await importer.prepareInstall({
        scanId: report.scanId,
        digest: report.digest,
        trustConfirmed: false,
        grantedPermissions: ['fs:read'],
      })
      throw new Error('Expected explicit trust to be required')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).context.reason).toBe('trust.confirmation-required')
    }

    const prepared = await importer.prepareInstall({
      scanId: report.scanId,
      digest: report.digest,
      trustConfirmed: true,
      grantedPermissions: ['fs:read'],
    })
    expect(prepared.grantedPermissions).toEqual(['fs:read'])
    expect(await Bun.file(join(prepared.stagingDirectory, 'velaros.mod.json')).exists()).toBe(true)
    await prepared.cleanup()
  })

  test('rejects unknown permissions and archive replacement after scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velarmod-replace-'))
    roots.push(root)
    const unknownArchive = join(root, 'unknown.velarmod')
    await writeArchive(unknownArchive, createManifest('1.0.0', ['host:unknown']))
    const importer = createImporter()
    expect((await importer.scan(unknownArchive)).installable).toBe(false)

    const archive = join(root, 'replace.velarmod')
    await writeArchive(archive, createManifest('1.0.0', []))
    const report = await importer.scan(archive)
    await writeArchive(archive, createManifest('2.0.0', []))
    await expect(importer.prepareInstall({
      scanId: report.scanId,
      digest: report.digest,
      trustConfirmed: true,
      grantedPermissions: [],
    })).rejects.toThrow('changed after confirmation')
  })

  test('rejects a traversal entry using its original ZIP path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velarmod-path-'))
    roots.push(root)
    const archive = join(root, 'unsafe.velarmod')
    const zip = new JSZip()
    zip.file('velaros.mod.json', JSON.stringify(createManifest('1.0.0', [])))
    zip.file('../escape.txt', 'escape')
    await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }))

    await expect(createImporter().scan(archive)).rejects.toThrow('escapes its root')
  })
})

function createImporter(): VelarModArchiveImporter {
  return new VelarModArchiveImporter({
    resolvePermission: (permission) => permission === 'fs:read'
      ? { id: permission, label: 'Read files', description: 'Read bounded files.', risk: 'standard' }
      : null,
  })
}

function createManifest(version: string, permissions: readonly string[]) {
  return {
    module: {
      id: 'review-kit',
      version,
      apiVersion: 1,
      provides: [],
      requires: [],
      optionalRequires: [],
      permissions,
      isolation: 'sidecar',
    },
    agent: {
      id: 'review-kit',
      version,
      displayName: 'Review Kit',
      manifestSchemaVersion: 1,
      engines: { velaros: '*', agent: '*' },
      trust: 'local-dev',
      permissions,
      contributes: {},
    },
  }
}

async function writeArchive(path: string, manifest: unknown): Promise<void> {
  const zip = new JSZip()
  zip.file('velaros.mod.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}
