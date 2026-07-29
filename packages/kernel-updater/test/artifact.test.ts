import {
  readdir,
  readFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  downloadKernelArtifact,
  kernelArtifactFileName,
  KernelArtifactVerificationError,
  parseKernelUpdateManifest,
  selectKernelArtifact,
  UnverifiedKernelArtifactSignatureVerifier,
} from '../src'

import {
  artifactOf,
  createFakeFetch,
  createTemporaryDirectories,
  digestOf,
  manifestOf,
} from './support'

const directories = createTemporaryDirectories('artifact')

afterEach(async () => {
  await directories.cleanup()
})

const payload = 'velaros-kernel-runtime-bytes-1.0.0'
const artifact = artifactOf('https://cdn.example.com/kernel-1.0.0.bin', payload)

function artifactFor(overrides: Readonly<Record<string, unknown>> = {}) {
  const manifest = parseKernelUpdateManifest(manifestOf([
    {
      version: '1.0.0',
      artifacts: { 'linux-x64': { ...artifact.descriptor, ...overrides } },
    },
  ]))
  return selectKernelArtifact(manifest, '1.0.0', 'linux-x64').artifact
}

describe('Kernel artifact download and verification', () => {
  test('streams an artifact to disk and confirms its SHA-256 digest', async () => {
    const directory = await directories.create()
    const destination = join(directory, 'payload')

    const result = await downloadKernelArtifact({
      artifact: artifactFor(),
      destination,
      fetch: createFakeFetch({ [artifact.descriptor.url]: artifact.bytes }),
    })

    expect(result).toMatchObject({
      path: destination,
      size: artifact.descriptor.size,
      sha256: artifact.descriptor.sha256,
    })
    const written = await readFile(destination)
    expect(written.toString('utf8')).toBe(payload)
    expect(digestOf(written)).toBe(artifact.descriptor.sha256)
  })

  test('rejects a digest mismatch and removes the partial download', async () => {
    const directory = await directories.create()
    const destination = join(directory, 'payload')
    const tampered = artifactFor({
      sha256: '0'.repeat(64),
    })

    const failure = downloadKernelArtifact({
      artifact: tampered,
      destination,
      fetch: createFakeFetch({ [artifact.descriptor.url]: artifact.bytes }),
    })

    await expect(failure).rejects.toBeInstanceOf(KernelArtifactVerificationError)
    await expect(failure).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
      details: { expected: '0'.repeat(64), actual: artifact.descriptor.sha256 },
    })
    expect(await readdir(directory)).toEqual([])
  })

  test('rejects a byte size that disagrees with the manifest', async () => {
    const directory = await directories.create()

    const shortDeclaration = downloadKernelArtifact({
      artifact: artifactFor({ size: artifact.descriptor.size - 4 }),
      destination: join(directory, 'short'),
      fetch: createFakeFetch({ [artifact.descriptor.url]: artifact.bytes }),
    })
    await expect(shortDeclaration).rejects.toMatchObject({
      code: 'ARTIFACT_SIZE_MISMATCH',
    })

    const longDeclaration = downloadKernelArtifact({
      artifact: artifactFor({ size: artifact.descriptor.size + 4 }),
      destination: join(directory, 'long'),
      fetch: createFakeFetch({ [artifact.descriptor.url]: artifact.bytes }),
    })
    await expect(longDeclaration).rejects.toMatchObject({
      code: 'ARTIFACT_SIZE_MISMATCH',
      details: { actual: String(artifact.descriptor.size) },
    })

    expect(await readdir(directory)).toEqual([])
  })

  test('maps transport failures onto DOWNLOAD_FAILED and leaves no file behind', async () => {
    const directory = await directories.create()

    await expect(downloadKernelArtifact({
      artifact: artifactFor(),
      destination: join(directory, 'missing'),
      fetch: createFakeFetch({}),
    })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', details: { actual: '404' } })

    await expect(downloadKernelArtifact({
      artifact: artifactFor(),
      destination: join(directory, 'interrupted'),
      fetch: createFakeFetch(
        { [artifact.descriptor.url]: artifact.bytes },
        { interruptAfterBytes: 8 },
      ),
    })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })

    expect(await readdir(directory)).toEqual([])
  })

  test('reports every artifact as unverified until a real verifier is injected', async () => {
    const verifier = new UnverifiedKernelArtifactSignatureVerifier()

    const result = await verifier.verify({
      version: '1.0.0',
      target: 'linux-x64',
      artifact: artifactFor(),
      payloadPath: '/tmp/payload',
      sha256: artifact.descriptor.sha256,
    })

    expect(result).toMatchObject({ verified: false, method: 'none' })
    expect(result.reason).toContain('verifier is installed')
  })

  test('derives a safe payload file name from the artifact URL', () => {
    expect(kernelArtifactFileName(artifactFor())).toBe('kernel-1.0.0.bin')
    expect(kernelArtifactFileName(artifactFor({
      url: 'https://cdn.example.com/downloads/kernel.tar.gz?token=abc',
    }))).toBe('kernel.tar.gz')
    expect(kernelArtifactFileName(artifactFor({ url: 'https://cdn.example.com/' })))
      .toBe('kernel-payload')
  })
})
