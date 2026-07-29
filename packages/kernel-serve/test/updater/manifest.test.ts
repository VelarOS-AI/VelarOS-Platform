import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  KernelUpdaterError,
  listKernelManifestVersions,
  loadKernelUpdateManifest,
  parseKernelUpdateManifest,
  resolveKernelArtifactTarget,
  selectKernelArtifact,
  selectKernelManifestVersion,
} from '../../src/updater'

import {
  artifactOf,
  createFakeFetch,
  createTemporaryDirectories,
  manifestOf,
} from './support'

const directories = createTemporaryDirectories('manifest')

afterEach(async () => {
  await directories.cleanup()
})

const darwinArtifact = artifactOf('https://cdn.example.com/1.0.0-darwin.bin', 'darwin')
const linuxArtifact = artifactOf('https://cdn.example.com/1.0.0-linux.bin', 'linux')

function validManifest(): unknown {
  return manifestOf([
    {
      version: '1.0.0',
      artifacts: {
        'darwin-arm64': darwinArtifact.descriptor,
        'linux-x64': linuxArtifact.descriptor,
      },
    },
    {
      version: '1.1.0',
      artifacts: {
        'linux-x64': {
          ...linuxArtifact.descriptor,
          url: 'https://cdn.example.com/1.1.0-linux.bin',
          format: 'tar.gz',
        },
      },
    },
    {
      version: '2.0.0',
      yanked: true,
      artifacts: { 'linux-x64': linuxArtifact.descriptor },
    },
  ])
}

describe('Kernel update manifest', () => {
  test('parses a published manifest and applies documented defaults', () => {
    const manifest = parseKernelUpdateManifest(validManifest())

    expect(manifest.channel).toBe('stable')
    expect(manifest.versions.map((entry) => entry.version))
      .toEqual(['1.0.0', '1.1.0', '2.0.0'])
    expect(manifest.versions[0]?.artifacts['darwin-arm64']).toMatchObject({
      url: darwinArtifact.descriptor.url,
      size: darwinArtifact.descriptor.size,
      sha256: darwinArtifact.descriptor.sha256,
      format: 'raw',
    })
    expect(manifest.versions[0]?.yanked).toBe(false)
    expect(manifest.versions[1]?.artifacts['linux-x64']?.format).toBe('tar.gz')
  })

  test('rejects malformed manifests with a typed error', () => {
    const malformed: readonly unknown[] = [
      undefined,
      null,
      'not a manifest',
      {},
      { schemaVersion: 2, versions: [] },
      manifestOf([]),
      manifestOf([{ version: 'latest', artifacts: {} }]),
      manifestOf([
        { version: '1.0.0', artifacts: { 'solaris-x64': darwinArtifact.descriptor } },
      ]),
      manifestOf([
        {
          version: '1.0.0',
          artifacts: {
            'linux-x64': { ...darwinArtifact.descriptor, sha256: 'not-a-digest' },
          },
        },
      ]),
      manifestOf([
        {
          version: '1.0.0',
          artifacts: { 'linux-x64': { ...darwinArtifact.descriptor, size: 0 } },
        },
      ]),
      manifestOf([
        {
          version: '1.0.0',
          artifacts: {
            'linux-x64': { ...darwinArtifact.descriptor, unexpected: true },
          },
        },
      ]),
    ]

    for (const input of malformed) {
      expect(() => parseKernelUpdateManifest(input)).toThrowError(KernelUpdaterError)
      expect(() => parseKernelUpdateManifest(input)).toThrowError(/invalid/i)
    }
  })

  test('rejects a manifest declaring the same version twice', () => {
    const duplicated = manifestOf([
      { version: '1.0.0', artifacts: { 'linux-x64': linuxArtifact.descriptor } },
      { version: '1.0.0', artifacts: { 'linux-x64': linuxArtifact.descriptor } },
    ])

    const error = captureError(() => parseKernelUpdateManifest(duplicated))
    expect(error).toMatchObject({ code: 'INVALID_MANIFEST', details: { version: '1.0.0' } })
  })

  test('resolves the artifact target for the running platform and architecture', () => {
    expect(resolveKernelArtifactTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveKernelArtifactTarget('win32', 'x64')).toBe('win32-x64')
    expect(resolveKernelArtifactTarget()).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/)
  })

  test('reports an unsupported platform or architecture distinctly', () => {
    for (const [platform, architecture] of [
      ['freebsd', 'x64'],
      ['linux', 'riscv64'],
    ]) {
      const error = captureError(() =>
        resolveKernelArtifactTarget(platform, architecture))
      expect(error).toMatchObject({
        code: 'UNSUPPORTED_TARGET',
        details: { target: `${platform}-${architecture}` },
      })
    }
  })

  test('selects the artifact matching the requested target', () => {
    const manifest = parseKernelUpdateManifest(validManifest())

    expect(selectKernelArtifact(manifest, '1.0.0', 'darwin-arm64')).toMatchObject({
      version: '1.0.0',
      target: 'darwin-arm64',
      artifact: { url: darwinArtifact.descriptor.url },
    })
    expect(selectKernelArtifact(manifest, '1.0.0', 'linux-x64').artifact.url)
      .toBe(linuxArtifact.descriptor.url)
  })

  test('fails with ARTIFACT_NOT_FOUND when no artifact matches the target', () => {
    const manifest = parseKernelUpdateManifest(validManifest())

    expect(captureError(() => selectKernelArtifact(manifest, '1.1.0', 'darwin-arm64')))
      .toMatchObject({
        code: 'ARTIFACT_NOT_FOUND',
        details: { version: '1.1.0', target: 'darwin-arm64' },
      })
    expect(captureError(() => selectKernelArtifact(manifest, '9.9.9', 'linux-x64')))
      .toMatchObject({ code: 'VERSION_UNAVAILABLE', details: { version: '9.9.9' } })
  })

  test('filters candidate versions by range, target, and yanked state', () => {
    const manifest = parseKernelUpdateManifest(validManifest())

    expect(
      listKernelManifestVersions(manifest, { target: 'linux-x64' })
        .map((entry) => entry.version),
    ).toEqual(['1.0.0', '1.1.0'])
    expect(
      listKernelManifestVersions(manifest, { target: 'darwin-arm64' })
        .map((entry) => entry.version),
    ).toEqual(['1.0.0'])
    expect(
      selectKernelManifestVersion(manifest, { range: '^1.0.0', target: 'linux-x64' })
        ?.version,
    ).toBe('1.1.0')
    expect(
      selectKernelManifestVersion(manifest, { range: '~1.0.0', target: 'linux-x64' })
        ?.version,
    ).toBe('1.0.0')
    expect(
      selectKernelManifestVersion(manifest, { range: '^2.0.0', target: 'linux-x64' }),
    ).toBeUndefined()
    expect(
      selectKernelManifestVersion(manifest, {
        range: '^2.0.0',
        target: 'linux-x64',
        includeYanked: true,
      })?.version,
    ).toBe('2.0.0')
  })

  test('loads a manifest from a local file and from an injected transport', async () => {
    const directory = await directories.create()
    const manifestPath = join(directory, 'kernel-updates.json')
    await writeFile(manifestPath, JSON.stringify(validManifest()), 'utf8')

    expect((await loadKernelUpdateManifest(manifestPath)).versions).toHaveLength(3)

    const remote = 'https://updates.example.com/kernel.json'
    const manifest = await loadKernelUpdateManifest(remote, {
      fetch: createFakeFetch({ [remote]: JSON.stringify(validManifest()) }),
    })
    expect(manifest.versions.map((entry) => entry.version))
      .toEqual(['1.0.0', '1.1.0', '2.0.0'])
  })

  test('reports unreachable and non-JSON manifests distinctly', async () => {
    const directory = await directories.create()
    const missing = join(directory, 'absent.json')
    await expect(loadKernelUpdateManifest(missing)).rejects.toMatchObject({
      code: 'MANIFEST_UNREACHABLE',
    })

    const broken = join(directory, 'broken.json')
    await writeFile(broken, '{ this is not json', 'utf8')
    await expect(loadKernelUpdateManifest(broken)).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    })
  })
})

function captureError(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected the operation to throw')
}
