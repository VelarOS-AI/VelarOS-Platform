import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'

import { Log } from '@velaros-ai/core'

import type { KernelArtifactDownloadOptions, KernelArtifactDownloadResult } from '../../types/updater'
import {
  KernelUpdaterError,
} from '../errors'

import { nodeKernelFetch } from './transport'

export type { KernelArtifactDownloadOptions, KernelArtifactDownloadResult } from '../../types/updater'
const log = Log.tag('KernelArtifactDownload')

/**
 * 把一份制品边下边算摘要地写到 `destination`，任何失败都把半截文件删掉。
 *
 * 字节从不整份留在内存里；活着走出这个函数的文件，逐字节就是清单承诺的那一份。大小对不上抛
 * ARTIFACT_SIZE_MISMATCH，摘要对不上抛 DIGEST_MISMATCH，取不到抛 DOWNLOAD_FAILED。
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
