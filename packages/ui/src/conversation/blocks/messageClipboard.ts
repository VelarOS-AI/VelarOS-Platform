import type { ChatMessage, ToolCallBlock } from '#contracts'
import { isRecord } from '#internal/runtime'

const RichClipboardAttachmentMime = 'web application/x-velaros-message-attachments+json'

export interface MessageClipboardAsset {
  id: string
  kind: 'image' | 'file'
  name: string
  mediaType: string
  dataUrl: Nullable<string>
  path: Nullable<string>
}

export interface MessageClipboardContent {
  plainText: string
  html: string
  uriList: string
  assets: MessageClipboardAsset[]
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
      dataUrl: dataUrl(block.modelImage.mediaType, block.modelImage.data),
      path,
    })
  }

  return assets
}

function buildPlainText(message: ChatMessage, assets: MessageClipboardAsset[]): string {
  const sections: string[] = []
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trimEnd())
    .filter(Boolean)
    .join('\n\n')
    .trim()
  if (text) sections.push(text)

  const references = assets.map((asset) => {
    const target = asset.path?.trim()
    const prefix = asset.kind === 'image' ? 'Image' : 'File'
    return target ? `${prefix}: ${asset.name} (${target})` : `${prefix}: ${asset.name}`
  })
  for (const block of message.blocks) {
    if (block.type === 'assistant-source' && block.url.trim()) {
      references.push(`${block.title?.trim() || 'Source'}: ${block.url.trim()}`)
    }
  }
  if (references.length) sections.push(references.join('\n'))

  return sections.join('\n\n')
}

function buildHtml(message: ChatMessage, assets: MessageClipboardAsset[]): string {
  const fragments: string[] = []
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trimEnd())
    .filter(Boolean)
    .join('\n\n')
    .trim()
  if (text) {
    fragments.push(`<div style="white-space:pre-wrap">${escapeHtml(text).replaceAll('\n', '<br>')}</div>`)
  }

  for (const asset of assets) {
    const pathUrl = asset.path ? fileHref(asset.path) : ''
    const href = asset.dataUrl || pathUrl
    const name = escapeHtml(asset.name)
    if (asset.kind === 'image' && href) {
      fragments.push(
        `<figure><img src="${escapeHtml(href)}" alt="${name}" style="max-width:100%;height:auto"><figcaption>${name}</figcaption></figure>`
      )
      continue
    }
    if (href) {
      const download = asset.dataUrl ? ` download="${name}"` : ''
      fragments.push(`<div><a href="${escapeHtml(href)}"${download}>${name}</a></div>`)
      continue
    }
    fragments.push(`<div>${name}</div>`)
  }

  for (const block of message.blocks) {
    if (block.type !== 'assistant-source' || !block.url.trim()) continue
    const url = block.url.trim()
    fragments.push(
      `<div><a href="${escapeHtml(url)}">${escapeHtml(block.title?.trim() || url)}</a></div>`
    )
  }

  return `<div data-velaros-message-clipboard="true">${fragments.join('')}</div>`
}

export function buildMessageClipboardContent(message: ChatMessage): MessageClipboardContent {
  const assets = collectMessageClipboardAssets(message)
  const uris = new Set<string>()
  for (const asset of assets) {
    if (!asset.path) continue
    const href = fileHref(asset.path)
    if (href) uris.add(href)
  }
  for (const block of message.blocks) {
    if (block.type === 'assistant-source' && /^https?:\/\//u.test(block.url.trim()))
      uris.add(block.url.trim())
  }

  return {
    plainText: buildPlainText(message, assets),
    html: buildHtml(message, assets),
    uriList: [...uris].join('\r\n'),
    assets,
  }
}

function buildRichAttachmentPayload(content: MessageClipboardContent): string {
  return JSON.stringify(
    content.assets.map((asset) => ({
      kind: asset.kind,
      name: asset.name,
      mediaType: asset.mediaType,
      dataUrl: asset.dataUrl,
      path: asset.path,
    }))
  )
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
  if (ClipboardItemConstructor.supports?.(RichClipboardAttachmentMime)) {
    item[RichClipboardAttachmentMime] = new Blob([buildRichAttachmentPayload(content)], {
      type: RichClipboardAttachmentMime,
    })
  }

  const nativeImage = content.assets.find(
    (asset) => !!asset.dataUrl && ClipboardItemConstructor.supports?.(asset.mediaType)
  )
  if (nativeImage?.dataUrl) {
    const imageBlob = dataUrlBlob(nativeImage.dataUrl, nativeImage.mediaType)
    if (imageBlob) item[nativeImage.mediaType] = imageBlob
  }

  try {
    await clipboard.write([new ClipboardItemConstructor(item)])
  } catch {
    await clipboard.writeText(content.plainText)
  }
}
