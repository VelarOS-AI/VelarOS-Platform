import { isArray, isBoolean, isString,Log } from '@velaros-ai/core'

import { type ContextPayloadStore, createContextPayloadRef } from '../ContextPayloadStore'

import type { FileSnapshotArchive } from './contracts'

export const FileSnapshotToolName = '__file_snapshot__'
export const FileObservationToolName = '__file_observation__'

async function contentHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 正文按内容去重，来源调用单独保存，重启后的任意分支都能恢复自己的读取范围。 */
async function saveObservation(
  store: ContextPayloadStore,
  sessionId: string,
  snapshot: FileSnapshotArchive,
  ref: string
): Promise<void> {
  if (!snapshot.sourceToolCallId) return
  const serializedResult = JSON.stringify({ kind: 'file-observation', ref })
  const hash = await contentHash(JSON.stringify([snapshot.sourceToolCallId, ref]))
  await store.put({
    sessionId,
    hash,
    payloadRef: createContextPayloadRef(sessionId, hash),
    toolCallId: snapshot.sourceToolCallId,
    toolName: FileObservationToolName,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
}

/** 存储不可变原文；视图、调用回执及版本目录只持有同一份内容引用。 */
export async function saveFileSnapshot(
  store: ContextPayloadStore,
  sessionId: string,
  snapshot: FileSnapshotArchive
): Promise<string> {
  // 源码候选和行记录仅用于本次呈现，归档只保存原始正文。
  const { viewSource: _viewSource, presentation: _presentation, ...archived } = snapshot
  const serializedResult = JSON.stringify(archived)
  const { sourceToolCallId: _sourceToolCallId, ...identity } = archived
  const hash = await contentHash(JSON.stringify(identity))
  const existing = await store.findByHash(sessionId, hash)
  if (existing) {
    const { sourceToolCallId: _previousCall, ...previous } = parseFileSnapshot(
      existing.serializedResult
    )
    if (JSON.stringify(previous) !== JSON.stringify(identity))
      throw new Error('File snapshot archive identity conflict')
    await saveObservation(store, sessionId, snapshot, existing.payloadRef)
    return existing.payloadRef
  }
  const payloadRef = createContextPayloadRef(sessionId, hash)
  const saved = await store.put({
    sessionId,
    hash,
    payloadRef,
    toolCallId: `file-snapshot:${hash}`,
    toolName: FileSnapshotToolName,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
  const { sourceToolCallId: _savedCall, ...savedIdentity } = parseFileSnapshot(
    saved.serializedResult
  )
  if (JSON.stringify(savedIdentity) !== JSON.stringify(identity))
    throw new Error('File snapshot archive identity conflict')
  await saveObservation(store, sessionId, snapshot, payloadRef)
  return payloadRef
}

export function parseFileSnapshot(text: string): FileSnapshotArchive {
  const value = JSON.parse(text) as FileSnapshotArchive
  if (
    !value ||
    value.kind !== 'file-snapshot' ||
    value.version !== 1 ||
    !isString(value.workspaceId) ||
    !isString(value.path) ||
    !isString(value.revision) ||
    !isString(value.content) ||
    !isBoolean(value.exists) ||
    !isBoolean(value.complete) ||
    !Number.isInteger(value.totalLines) ||
    value.totalLines < 0 ||
    !value.range ||
    !Number.isInteger(value.range.startLine) ||
    value.range.startLine < 1 ||
    !Number.isInteger(value.range.endLine) ||
    value.range.endLine < value.range.startLine
  ) {
    throw new Error('Invalid file snapshot archive')
  }
  return value
}

export function tryParseFileSnapshot(text: string): FileSnapshotArchive | undefined {
  try {
    return parseFileSnapshot(text)
  } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')

    return undefined
  }
}

/** 自动边界不拆 UTF-16 代理对或 CRLF；offset 必须由本函数的 nextOffset 续读。 */
export function sliceFileSnapshot(text: string, offset: number, maxChars: number) {
  if (offset < 0 || offset > text.length || !Number.isInteger(offset))
    throw new Error('Invalid snapshot offset')
  const splitsPair = (at: number) =>
    at > 0 &&
    at < text.length &&
    ((text.charCodeAt(at - 1) >= 0xd800 &&
      text.charCodeAt(at - 1) <= 0xdbff &&
      text.charCodeAt(at) >= 0xdc00 &&
      text.charCodeAt(at) <= 0xdfff) ||
      (text[at - 1] === '\r' && text[at] === '\n'))
  if (splitsPair(offset))
    throw new Error('Snapshot offset splits a character or CRLF; use the returned nextOffset')
  let end = Math.min(text.length, offset + Math.max(2, maxChars))
  if (splitsPair(end)) end -= 1
  return { content: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null }
}

export interface FileRenameArchive {
  kind: 'file-rename'
  workspaceId: string
  from: string
  to: string
  beforeRevision: string
  afterRevision: string
  refs: string[]
}

export function tryParseFileRename(text: string): FileRenameArchive | undefined {
  try {
    const value = JSON.parse(text) as FileRenameArchive
    if (
      !value ||
      value.kind !== 'file-rename' ||
      !isString(value.workspaceId) ||
      !isString(value.from) ||
      !isString(value.to) ||
      !isString(value.beforeRevision) ||
      !isString(value.afterRevision) ||
      !isArray(value.refs) ||
      !value.refs.every((ref) => isString(ref))
    )
      return undefined
    return value
  } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')

    return undefined
  }
}

/** 只保存已确认版本的迁移引用，不把删除后同名新文件并入旧谱系。 */
export async function saveFileRename(
  store: ContextPayloadStore,
  sessionId: string,
  rename: Omit<FileRenameArchive, 'kind' | 'refs'>
): Promise<void> {
  const refs = new Set<string>()
  for (const record of await store.listForSession(sessionId)) {
    if (record.toolName === FileSnapshotToolName) {
      const snapshot = tryParseFileSnapshot(record.serializedResult)
      if (!snapshot) continue
      if (
        snapshot.workspaceId === rename.workspaceId &&
        snapshot.path === rename.from &&
        snapshot.revision === rename.beforeRevision
      )
        refs.add(record.payloadRef)
    } else if (record.toolName === '__file_rename__') {
      const previous = tryParseFileRename(record.serializedResult)
      if (!previous) continue
      if (
        previous.workspaceId === rename.workspaceId &&
        previous.to === rename.from &&
        previous.afterRevision === rename.beforeRevision
      )
        for (const ref of previous.refs) refs.add(ref)
    }
  }
  const value: FileRenameArchive = { kind: 'file-rename', ...rename, refs: [...refs].sort() }
  const serializedResult = JSON.stringify(value)
  const hash = await contentHash(serializedResult)
  await store.put({
    sessionId,
    hash,
    payloadRef: createContextPayloadRef(sessionId, hash),
    toolCallId: `file-rename:${hash}`,
    toolName: '__file_rename__',
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
}
