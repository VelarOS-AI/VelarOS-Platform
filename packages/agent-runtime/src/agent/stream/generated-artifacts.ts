import type { TextStreamPart, ToolSet } from 'ai'

import { Log } from '@velaros-ai/core'
import type {
  StreamAssistantGeneratedFilePayload,
  StreamAssistantSourcePayload,
} from '@velaros-ai/core/types'

const MaxGeneratedFileBytes = 20 * 1024 * 1024
const generatedArtifactsLog = Log.tag('GeneratedArtifacts')

type ProviderStreamPart = TextStreamPart<ToolSet>

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

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
      ...(part.title?.trim() ? { title: part.title.trim() } : {}),
    }
  } catch (error) {
    generatedArtifactsLog.caught('忽略模型返回的无效来源地址', error)
    return null
  }
}
