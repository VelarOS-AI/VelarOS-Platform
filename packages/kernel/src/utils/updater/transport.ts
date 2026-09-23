import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isNotUndefined, isNull } from '@velaros-ai/core'

import type { KernelFetch } from '../../contract/requires'
import { KernelUpdaterError } from '../errors'
import { isNodeError } from '../fs'
import { KernelTuning } from '../tuning'

export type { KernelFetch } from '../../contract/requires'
export type { KernelFetchRequest, KernelFetchResponse } from '../../types/updater'
/** URL 前面那段协议名的样子，用来区分「带协议的地址」与「裸路径」。 */
const SchemePattern = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 读不到东西时给出的空回应体。 */
const EmptyResponseBody: AsyncIterable<Uint8Array> = {
  async *[Symbol.asyncIterator]() {},
}

/** 一份更新清单最多读这么多字节，超了就当取不到，免得一个坏来源把内存撑爆。 */
export const MaximumKernelManifestBytes = KernelTuning.updaterMaxManifestBytes

/** 判断一个来源是不是要走网络取（`http://` 或 `https://`）。 */
export function isRemoteKernelUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

/** 缺省取数实现：`http(s)` 走全局 `fetch`，其余按本机路径读；文件不在时报 404 而不是抛。 */
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

/** 把一个来源整份读成文本；状态码不是 2xx、读不动或超过体积上限都抛 MANIFEST_UNREACHABLE。 */
export async function fetchKernelText(
  fetchImplementation: KernelFetch,
  url: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetchImplementation({ url, signal })
  if (response.status < 200 || response.status >= 300) {
    throw new KernelUpdaterError(
      'MANIFEST_UNREACHABLE',
      `取内核更新清单失败，HTTP 状态 ${response.status}`,
      { url, actual: String(response.status) }
    )
  }

  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MaximumKernelManifestBytes) {
        throw new KernelUpdaterError('MANIFEST_UNREACHABLE', '内核更新清单超过了允许的最大体积', {
          url,
          expected: String(MaximumKernelManifestBytes),
        })
      }
      chunks.push(chunk)
    }
  } catch (error) {
    throw error instanceof KernelUpdaterError
      ? error
      : new KernelUpdaterError(
          'MANIFEST_UNREACHABLE',
          `读不出 "${url}" 处的内核更新清单`,
          { url },
          { cause: error }
        )
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 把一个来源折成本机路径；`file:` URL 与绝对路径都认，别的协议抛 DOWNLOAD_FAILED。 */
function toLocalPath(source: string): string {
  if (source.startsWith('file:')) return fileURLToPath(source)
  if (!SchemePattern.test(source) || isAbsolute(source)) return source
  throw new KernelUpdaterError('DOWNLOAD_FAILED', `"${source}" 用了不支持的内核制品 URL 协议`, {
    url: source,
  })
}

/** 把 Web 的 ReadableStream 转成按块产出的异步迭代器；流为空时一个块都不产。 */
async function* readWebStream(
  stream: Nullable<ReadableStream<Uint8Array>>
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
