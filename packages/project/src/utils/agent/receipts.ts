/**
 * 项目回执：变更回执（change:）、列表续页游标（list-page:）这类不透明引用的签发与核对，记录存在会话的上下文载荷里。
 */

import { createHash } from 'node:crypto'

import type { ProjectToolContext } from '../../contract/requires'
import { ProjectError } from '../errors.js'

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

/** 每种回执引用的来历与下一步：引用只能原样复制本会话的回执，坏了就照这句重来。 */
const ReceiptNextActions: Readonly<Record<string, string>> = Object.freeze({
  change: 'changeRef 只能原样复制本会话 project:edit 成功回执里的值。',
  'list-page': '去掉 cursor，按原来的条件重新列一次，再用新回执里的 cursor 续页。',
})

/** 引用不可用时的下一步；没登记的种类给一句通用的。 */
function receiptNextAction(kind: string): string {
  return ReceiptNextActions[kind] ?? '引用只能原样复制本会话回执里的值，不能手写或改写。'
}

/** 凭引用取回回执内容：种类不对、会话里没有、或不属于当前项目时按 INVALID_INPUT 拒绝，并说明怎么拿到有效的引用。 */
export async function readProjectReceipt(
  context: ProjectToolContext,
  kind: string,
  ref: string,
): Promise<unknown> {
  const invalid = (message: string): ProjectError =>
    new ProjectError('INVALID_INPUT', message, { ref: ref.slice(0, 80) }, receiptNextAction(kind))
  if (!ref.startsWith(`${kind}:`) || !context.sessionId || !context.contextPayloadStore)
    throw invalid(`${ref.slice(0, 80)} 不是本会话签发的 ${kind} 引用。`)
  const stored = await context.contextPayloadStore.findByHash(context.sessionId, ref.slice(kind.length + 1))
  if (!stored || stored.toolName !== `__project_${kind}__`)
    throw invalid(`这个 ${kind} 引用不是本会话签发的值，或者已经过期。`)
  const record = JSON.parse(stored.serializedResult) as { kind: string; workspace: string; value: unknown }
  if (record.kind !== kind || record.workspace !== context.project.getRootPath())
    throw invalid('这个引用属于另一个项目。')
  return record.value
}
