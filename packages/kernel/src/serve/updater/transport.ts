import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isNotUndefined, isNull } from '@velaros-ai/core'

import { KernelUpdaterError } from './errors'
import { isNodeError } from './fs-utils'

export interface KernelFetchRequest {
  readonly url: string
  readonly signal?: AbortSignal
}

export interface KernelFetchResponse {
  readonly status: number
  readonly body: AsyncIterable<Uint8Array>
}

/**
 * Byte source for manifests and artifacts. Everything the updater reads from
 * outside the install root goes through this function, so tests and offline
 * hosts substitute their own transport instead of reaching the network.
 */
export type KernelFetch = (
  request: KernelFetchRequest,
) => Promise<KernelFetchResponse>

const SchemePattern = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

const EmptyResponseBody: AsyncIterable<Uint8Array> = {
   
  async *[Symbol.asyncIterator]() {},
}

export const MaximumKernelManifestBytes = 8 * 1024 * 1024

export function isRemoteKernelUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

/** Default transport: HTTP(S) through global `fetch`, everything else from disk. */
export const nodeKernelFetch: KernelFetch = async (request) => {
  if (isRemoteKernelUrl(request.url)) {
    const response = await fetch(request.url, {
      redirect: 'follow',
      signal: request.signal,
    })
    return { status: response.status, body: readWebStream(response.body) }
  }

  const path = toLocalPath(request.url)
  try {
    await stat(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    return { status: 404, body: EmptyResponseBody }
  }
  return { status: 200, body: createReadStream(path) }
}

export async function fetchKernelText(
  fetchImplementation: KernelFetch,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImplementation({ url, signal })
  if (response.status < 200 || response.status >= 300) {
    throw new KernelUpdaterError(
      'MANIFEST_UNREACHABLE',
      `Kernel update manifest request failed with status ${response.status}`,
      { url, actual: String(response.status) },
    )
  }

  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MaximumKernelManifestBytes) {
        throw new KernelUpdaterError(
          'MANIFEST_UNREACHABLE',
          'Kernel update manifest exceeds the maximum accepted size',
          { url, expected: String(MaximumKernelManifestBytes) },
        )
      }
      chunks.push(chunk)
    }
  } catch (error) {
    throw error instanceof KernelUpdaterError
      ? error
      : new KernelUpdaterError(
        'MANIFEST_UNREACHABLE',
        `Kernel update manifest at "${url}" could not be read`,
        { url },
        { cause: error },
      )
  }
  return Buffer.concat(chunks).toString('utf8')
}

function toLocalPath(source: string): string {
  if (source.startsWith('file:')) return fileURLToPath(source)
  if (!SchemePattern.test(source) || isAbsolute(source)) return source
  throw new KernelUpdaterError(
    'DOWNLOAD_FAILED',
    `Unsupported Kernel artifact URL scheme in "${source}"`,
    { url: source },
  )
}

async function* readWebStream(
  stream: Nullable<ReadableStream<Uint8Array>>,
): AsyncGenerator<Uint8Array> {
  if (isNull(stream)) return
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (isNotUndefined(value)) yield value
    }
  } finally {
    reader.releaseLock()
  }
}
