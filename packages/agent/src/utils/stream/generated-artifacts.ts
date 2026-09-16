
import { isNonBlankString, Log, optionalWhen } from '@velaros-ai/core'

import type {
  StreamAssistantGeneratedFilePayload,
  StreamAssistantSourcePayload,
} from '../../types/agent'
import type { ProviderStreamPart } from '../../types/loop.js'

const MaxGeneratedFileBytes = 20 * 1024 * 1024
const generatedArtifactsLog = Log.tag('GeneratedArtifacts')

/**
 * 由 base64 串长度估算解码后的字节数（`len*3/4` 再减去尾部 `=` 填充），不真正解码。
 * 用于在把大文件读进内存之前先做体积门限判断；串非法或过短时结果夹到 0，不会返回负数。
 */
function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

/**
 * 从流分片里读出模型生成的文件制品（图片、音频等）。
 * 只认 `type === 'file'` 的分片；mediaType 为空、数据为空、估算体积 ≤ 0 或超过 20MB 上限的一律返回 null 丢弃——
 * 宁可不显示这一件制品，也不要把超大 base64 灌进会话历史。通过时就地分配一个 uuid 作为制品 id。
 */
export function readGeneratedFilePayload(
  part: ProviderStreamPart
): Nullable<StreamAssistantGeneratedFilePayload> {
  if (part.type !== 'file') return null
  const data = part.file.base64
  const mediaType = part.file.mediaType.trim()
  const size = estimateBase64Bytes(data)
  if (!mediaType || !data || size <= 0 || size > MaxGeneratedFileBytes) return null

  return {
    id: crypto.randomUUID(),
    mediaType,
    data,
    size,
  }
}

/**
 * 从流分片里读出模型引用的来源链接（联网检索类模型会发）。
 * 只认 `type === 'source'` 且 `sourceType === 'url'`；地址会过一遍 `new URL` 归一，
 * **只放行 http/https**（挡掉 `javascript:`、`data:` 这类协议）；解析不了的地址记一条日志后返回 null 丢弃。
 * 分片自带 id 就沿用，没有才生成 uuid；标题空白时不带这一格。
 */
export function readSourcePayload(
  part: ProviderStreamPart
): Nullable<StreamAssistantSourcePayload> {
  if (part.type !== 'source' || part.sourceType !== 'url') return null
  try {
    const url = new URL(part.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return {
      id: part.id || crypto.randomUUID(),
      sourceType: 'url',
      url: url.toString(),
      title: optionalWhen(isNonBlankString, part.title?.trim()),
    }
  } catch (error) {
    generatedArtifactsLog.caught('忽略模型返回的无效来源地址', error)
    return null
  }
}
