/**
 * 项目回执：变更回执（change:）、列表续页游标（list-page:）这类不透明引用的签发与核对，记录存在会话的上下文载荷里。
 */

import { createHash } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type { ProjectToolContext } from '../../contract/requires'

/** 存一张回执，返回「kind: + 内容哈希」形式的不透明引用；宿主没给会话号或上下文载荷存储时不签发，返回 undefined。 */
export async function saveProjectReceipt(
  context: ProjectToolContext,
  kind: string,
  value: unknown,
): Promise<string | undefined> {
  if (!context.sessionId || !context.contextPayloadStore) return undefined
  const serializedResult = JSON.stringify({ kind, workspace: context.project.getRootPath(), value })
  const hash = createHash('sha256').update(serializedResult).digest('hex')
  const ref = `${kind}:${hash}`
  await context.contextPayloadStore.put({
    sessionId: context.sessionId,
    hash,
    payloadRef: `ctx-payload:${encodeURIComponent(context.sessionId)}:${hash}`,
    toolCallId: ref,
    toolName: `__project_${kind}__`,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
  return ref
}

/** 凭引用取回回执内容：种类不对、会话里没有、或不属于当前工作区时抛错，让模型只用当前会话返回的引用。 */
export async function readProjectReceipt(
  context: ProjectToolContext,
  kind: string,
  ref: string,
): Promise<unknown> {
  if (!ref.startsWith(`${kind}:`) || !context.sessionId || !context.contextPayloadStore)
    throw new AppError('VALIDATION', '项目引用不可用，请使用当前会话返回的引用。')
  const stored = await context.contextPayloadStore.findByHash(context.sessionId, ref.slice(kind.length + 1))
  if (!stored || stored.toolName !== `__project_${kind}__`)
    throw new AppError('VALIDATION', '项目引用不存在或不属于当前会话。')
  const record = JSON.parse(stored.serializedResult) as { kind: string; workspace: string; value: unknown }
  if (record.kind !== kind || record.workspace !== context.project.getRootPath())
    throw new AppError('PERMISSION', '项目引用不属于当前工作区。')
  return record.value
}
