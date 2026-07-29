import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'

import {
  KernelArtifactVerificationError,
  KernelUpdaterError,
} from './errors'
import type { KernelArtifact } from './manifest'
import {
  type KernelFetch,
  nodeKernelFetch,
} from './transport'

export interface KernelArtifactDownloadOptions {
  readonly artifact: KernelArtifact
  readonly destination: string
  readonly fetch?: KernelFetch
  readonly signal?: AbortSignal
}

export interface KernelArtifactDownloadResult {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

/**
 * Streams an artifact to `destination`, hashing as it goes, and removes the
 * partial file on any failure. Bytes are never buffered in memory, and a file
 * that survives this call is byte-for-byte what the manifest promised.
 */
export async function downloadKernelArtifact(
  options: KernelArtifactDownloadOptions,
): Promise<KernelArtifactDownloadResult> {
  const { artifact, destination } = options
  const fetchImplementation = options.fetch ?? nodeKernelFetch
  const hash = createHash('sha256')
  const handle = await open(destination, 'w', 0o600)
  let size = 0

  try {
    const response = await fetchImplementation({
      url: artifact.url,
      signal: options.signal,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new KernelUpdaterError(
        'DOWNLOAD_FAILED',
        `Kernel artifact request failed with status ${response.status}`,
        { url: artifact.url, actual: String(response.status) },
      )
    }
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > artifact.size) {
        throw new KernelArtifactVerificationError(
          'ARTIFACT_SIZE_MISMATCH',
          'Kernel artifact is larger than the manifest declares',
          { url: artifact.url, expected: String(artifact.size) },
        )
      }
      hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(destination, { force: true })
    throw error instanceof KernelUpdaterError
      ? error
      : new KernelUpdaterError(
        'DOWNLOAD_FAILED',
        `Kernel artifact download from "${artifact.url}" failed`,
        { url: artifact.url },
        { cause: error },
      )
  }

  if (size !== artifact.size) {
    await rm(destination, { force: true })
    throw new KernelArtifactVerificationError(
      'ARTIFACT_SIZE_MISMATCH',
      `Kernel artifact size ${size} does not match the manifest`,
      {
        url: artifact.url,
        expected: String(artifact.size),
        actual: String(size),
      },
    )
  }

  const digest = hash.digest('hex')
  if (digest !== artifact.sha256) {
    await rm(destination, { force: true })
    throw new KernelArtifactVerificationError(
      'DIGEST_MISMATCH',
      'Kernel artifact SHA-256 digest does not match the manifest',
      { url: artifact.url, expected: artifact.sha256, actual: digest },
    )
  }

  return { path: destination, size, sha256: digest }
}
