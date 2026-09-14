import { createHash } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type { ProjectToolContext } from '../Types'

/** Opaque, immutable host receipts; query cursors and change references share scope checks. */
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
