import { isArray, isBoolean, isString,Log } from '@velaros-ai/core'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { FileRenameArchive,FileSnapshotArchive } from '../../types/context.js'

import { buildContextPayloadRef } from './payload-ref'

export const FileSnapshotToolName = '__file_snapshot__'
export const FileObservationToolName = '__file_observation__'

/** 算一段正文的 SHA-256 十六进制摘要：同一份文件内容只存一份载荷，靠它做去重键。 */
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
    payloadRef: buildContextPayloadRef(sessionId, hash),
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
      throw new Error('文件快照归档的身份冲突：同一个内容哈希下已存在一条身份字段不一样的快照，说明哈希键和正文对不上，不能覆盖已归档的原文。')
    await saveObservation(store, sessionId, snapshot, existing.payloadRef)
    return existing.payloadRef
  }
  const payloadRef = buildContextPayloadRef(sessionId, hash)
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
    throw new Error('文件快照归档的身份冲突：同一个内容哈希下已存在一条身份字段不一样的快照，说明哈希键和正文对不上，不能覆盖已归档的原文。')
  await saveObservation(store, sessionId, snapshot, payloadRef)
  return payloadRef
}

/** 把一条归档正文解析成文件快照；字段缺失或形状不对一律抛错，不返回半截对象。 */
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
    throw new Error('文件快照归档记录不合法：kind、version、workspaceId、path、revision、content、exists、complete、totalLines 或 range 里有字段缺失或形状不对，这条记录已经坏了，不返回半截对象。')
  }
  return value
}

/** 宽容版的文件快照解析：解不出来时返回 undefined 并留一条 debug 日志，让投影跳过这条记录而不是整轮失败。 */
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
    throw new Error('快照续读的 offset 不合法：它必须是 0 到正文长度之间的整数，请用上一次返回的 nextOffset 续读。')
  const splitsPair = (at: number) =>
    at > 0 &&
    at < text.length &&
    ((text.charCodeAt(at - 1) >= 0xd800 &&
      text.charCodeAt(at - 1) <= 0xdbff &&
      text.charCodeAt(at) >= 0xdc00 &&
      text.charCodeAt(at) <= 0xdfff) ||
      (text[at - 1] === '\r' && text[at] === '\n'))
  if (splitsPair(offset))
    throw new Error('快照续读的 offset 落在一个字符或 CRLF 中间：请用上一次返回的 nextOffset 继续读，不要自己算偏移。')
  let end = Math.min(text.length, offset + Math.max(2, maxChars))
  if (splitsPair(end)) end -= 1
  return { content: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null }
}

/** 宽容版的文件改名记录解析：解不出来时返回 undefined，调用方按「这条不是改名记录」继续往下走。 */
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
    payloadRef: buildContextPayloadRef(sessionId, hash),
    toolCallId: `file-rename:${hash}`,
    toolName: '__file_rename__',
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
}
