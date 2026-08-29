import type { ChatMessage, ToolCallBlock } from '#contracts'
import { isRecord } from '#internal/runtime'

export const VelarMessageClipboardMime = 'web application/x-velaros-message-attachments+json'
const VelarMessageClipboardLegacyMime = VelarMessageClipboardMime.replace(/^web /u, '')
const MaxVelarMessageClipboardPayloadChars = 64 * 1_024 * 1_024
const MaxVelarMessageClipboardAssets = 32

export interface MessageClipboardAsset {
  id: string
  kind: 'image' | 'file'
  name: string
  mediaType: string
  size: number
  lastModified: Nullable<number>
  dataUrl: Nullable<string>
  path: Nullable<string>
}

export interface MessageClipboardContent {
  messageText: string
  plainText: string
  html: string
  uriList: string
  assets: MessageClipboardAsset[]
}

export interface VelarMessageClipboardPaste {
  text: string
  files: File[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function dataUrl(mediaType: string, data: string): string {
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`
}

function fileHref(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
  if (!absolute) return ''

  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash).replaceAll('#', '%23')}`
}

function readString(record: Nullable<Record<string, unknown>>, key: string): Nullable<string> {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readToolAssetPath(block: ToolCallBlock): Nullable<string> {
  const args = isRecord(block.args) ? block.args : null
  const result = isRecord(block.result) ? block.result : null

  return (
    readString(result, 'path') ??
    readString(result, 'filePath') ??
    readString(result, 'imagePath') ??
    readString(result, 'relativePath') ??
    readString(args, 'path') ??
    readString(args, 'filePath') ??
    readString(args, 'imagePath')
  )
}

function basename(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

function collectMessageClipboardAssets(message: ChatMessage): MessageClipboardAsset[] {
  const assets: MessageClipboardAsset[] = []
  const ids = new Set<string>()
  const serializedImages = new Map(
    (message.serialized?.imageAttachments ?? []).map((attachment) => [attachment.id, attachment])
  )
  const append = (asset: MessageClipboardAsset): void => {
    if (ids.has(asset.id)) return
    ids.add(asset.id)
    assets.push(asset)
  }

  for (const attachment of message.attachments ?? []) {
    const image = serializedImages.get(attachment.id)
    append({
      id: `attachment:${attachment.id}`,
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      lastModified: attachment.lastModified ?? null,
      dataUrl: image ? dataUrl(image.mediaType, image.data) : null,
      path: attachment.path?.trim() || null,
    })
  }

  for (const block of message.blocks) {
    if (block.type === 'assistant-generated-file') {
      const name = block.filename?.trim() || block.id
      append({
        id: `generated:${block.id}`,
        kind: block.mediaType.toLowerCase().startsWith('image/') ? 'image' : 'file',
        name,
        mediaType: block.mediaType,
        size: block.size,
        lastModified: null,
        dataUrl: block.data ? dataUrl(block.mediaType, block.data) : null,
        path: null,
      })
      continue
    }

    if (block.type !== 'tool-call' || !block.modelImage?.data) continue
    const path = readToolAssetPath(block)
    append({
      id: `tool-image:${block.toolCallId}`,
      kind: 'image',
      name: path ? basename(path) : block.title?.trim() || block.toolName,
      mediaType: block.modelImage.mediaType,
      size: 0,
      lastModified: null,
      dataUrl: dataUrl(block.modelImage.mediaType, block.modelImage.data),
      path,
    })
  }

  return assets
}

function buildMessageText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trimEnd())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function collectExternalLinks(message: ChatMessage, assets: MessageClipboardAsset[]): string[] {
  const links = new Set<string>()
  for (const asset of assets) {
    if (!asset.path) continue
    const href = fileHref(asset.path)
    if (href) links.add(href)
  }

  for (const block of message.blocks) {
    const url = block.type === 'assistant-source' ? block.url.trim() : ''
    if (/^https?:\/\//u.test(url)) {
      links.add(url)
    }
  }

  return [...links]
}

function buildPlainText(messageText: string, externalLinks: string[]): string {
  const sections: string[] = []
  if (messageText) sections.push(messageText)
  if (externalLinks.length) sections.push(externalLinks.join('\n'))

  return sections.join('\n\n')
}

function buildHtml(messageText: string, externalLinks: string[]): string {
  const fragments: string[] = []
  if (messageText) {
    fragments.push(
      `<div style="white-space:pre-wrap">${escapeHtml(messageText).replaceAll('\n', '<br>')}</div>`
    )
  }

  for (const url of externalLinks) {
    const escapedUrl = escapeHtml(url)
    fragments.push(`<div><a href="${escapedUrl}">${escapedUrl}</a></div>`)
  }

  return `<div data-velaros-message-clipboard="true">${fragments.join('')}</div>`
}

export function buildMessageClipboardContent(message: ChatMessage): MessageClipboardContent {
  const assets = collectMessageClipboardAssets(message)
  const messageText = buildMessageText(message)
  const externalLinks = collectExternalLinks(message, assets)

  return {
    messageText,
    plainText: buildPlainText(messageText, externalLinks),
    html: buildHtml(messageText, externalLinks),
    uriList: externalLinks.join('\r\n'),
    assets,
  }
}

function buildRichAttachmentPayload(content: MessageClipboardContent): string {
  return JSON.stringify({
    version: 1,
    text: content.messageText,
    assets: content.assets.map((asset) => ({
      kind: asset.kind,
      name: asset.name,
      mediaType: asset.mediaType,
      size: asset.size,
      lastModified: asset.lastModified,
      dataUrl: asset.dataUrl,
      path: asset.path,
    })),
  })
}

function dataUrlBlob(value: string, fallbackMediaType: string): Nullable<Blob> {
  const separator = value.indexOf(',')
  if (!value.startsWith('data:') || separator < 0) return null

  const metadata = value.slice(5, separator)
  const encoded = value.slice(separator + 1)
  const parts = metadata.split(';')
  const mediaType = parts[0]?.trim() || fallbackMediaType

  try {
    if (parts.includes('base64')) {
      const decoded = atob(encoded)
      const bytes = new Uint8Array(decoded.length)
      for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index)
      }
      return new Blob([bytes], { type: mediaType })
    }

    return new Blob([decodeURIComponent(encoded)], { type: mediaType })
  } catch {
    return null
  }
}

function readVelarClipboardData(dataTransfer: DataTransfer): string {
  try {
    return (
      dataTransfer.getData(VelarMessageClipboardMime)
      || dataTransfer.getData(VelarMessageClipboardLegacyMime)
    )
  } catch {
    return ''
  }
}

function restoreClipboardFile(value: unknown): Nullable<File> {
  if (!isRecord(value)) return null

  const kind = value['kind']
  const name = value['name']
  const mediaType = value['mediaType']
  const data = value['dataUrl']
  const path = value['path']
  if (
    (kind !== 'image' && kind !== 'file')
    || typeof name !== 'string'
    || !name.trim()
    || name.length > 1_024
    || typeof mediaType !== 'string'
    || mediaType.length > 255
  ) return null

  const normalizedPath = typeof path === 'string' && path.trim() ? path.trim() : null
  const blob = typeof data === 'string' ? dataUrlBlob(data, mediaType) : null
  if (!blob && !normalizedPath) return null

  const declaredLastModified = value['lastModified']
  const lastModified =
    typeof declaredLastModified === 'number' && Number.isFinite(declaredLastModified)
      ? declaredLastModified
      : Date.now()
  const file = new File(blob ? [blob] : [], name.trim(), {
    type: mediaType,
    lastModified,
  })

  if (normalizedPath) {
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: normalizedPath,
    })
  }

  const declaredSize = value['size']
  if (!blob && typeof declaredSize === 'number' && Number.isFinite(declaredSize) && declaredSize >= 0) {
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: declaredSize,
    })
  }

  return file
}

export function readVelarMessageClipboard(
  dataTransfer: DataTransfer
): Nullable<VelarMessageClipboardPaste> {
  const raw = readVelarClipboardData(dataTransfer)
  if (!raw || raw.length > MaxVelarMessageClipboardPayloadChars) return null

  try {
    const payload: unknown = JSON.parse(raw)
    if (!isRecord(payload) || payload['version'] !== 1 || typeof payload['text'] !== 'string') return null

    const assets = Array.isArray(payload['assets'])
      ? payload['assets'].slice(0, MaxVelarMessageClipboardAssets)
      : []
    const files = assets.map(restoreClipboardFile).filter((file): file is File => !!file)
    return { text: payload['text'], files }
  } catch {
    return null
  }
}

export async function writeMessageClipboardContent(
  content: MessageClipboardContent
): Promise<void> {
  const clipboard = navigator.clipboard
  const ClipboardItemConstructor = globalThis.ClipboardItem

  if (!clipboard.write || !ClipboardItemConstructor) {
    await clipboard.writeText(content.plainText)
    return
  }

  const item: Record<string, Blob> = {
    'text/plain': new Blob([content.plainText], { type: 'text/plain' }),
    'text/html': new Blob([content.html], { type: 'text/html' }),
  }
  if (content.uriList && ClipboardItemConstructor.supports?.('text/uri-list')) {
    item['text/uri-list'] = new Blob([content.uriList], { type: 'text/uri-list' })
  }
  item[VelarMessageClipboardMime] = new Blob([buildRichAttachmentPayload(content)], {
    type: VelarMessageClipboardMime,
  })

  try {
    await clipboard.write([new ClipboardItemConstructor(item)])
  } catch {
    await clipboard.writeText(content.plainText)
  }
}
