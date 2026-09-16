import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'

import { Log } from '@velaros-ai/core'

import {
  KernelUpdaterError,
} from '../errors'

import type { KernelArtifact } from './manifest'
import {
  type KernelFetch,
  nodeKernelFetch,
} from './transport'

const log = Log.tag('KernelArtifactDownload')

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
        `取内核制品失败，HTTP 状态 ${response.status}`,
        { url: artifact.url, actual: String(response.status) },
      )
    }
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > artifact.size) {
        throw new KernelUpdaterError(
          'ARTIFACT_SIZE_MISMATCH',
          '内核制品比清单声明的还大',
          { url: artifact.url, expected: String(artifact.size) },
        )
      }
      hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.close()
  } catch (error) {
    await handle.close().catch((cleanupError) => {
      log.warn('清理时关闭内核制品文件句柄失败', {
        error: cleanupError,
        path: destination,
      })
    })
    await rm(destination, { force: true })
    if (error instanceof KernelUpdaterError) throw error
    throw new KernelUpdaterError(
      'DOWNLOAD_FAILED',
      `从 "${artifact.url}" 下载内核制品失败`,
      { url: artifact.url },
      { cause: error },
    )
  }

  if (size !== artifact.size) {
    await rm(destination, { force: true })
    throw new KernelUpdaterError(
      'ARTIFACT_SIZE_MISMATCH',
      `内核制品实际字节数 ${size} 与清单声明的不一致`,
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
    throw new KernelUpdaterError(
      'DIGEST_MISMATCH',
      '内核制品的 SHA-256 与清单声明的不一致',
      { url: artifact.url, expected: artifact.sha256, actual: digest },
    )
  }

  return { path: destination, size, sha256: digest }
}
