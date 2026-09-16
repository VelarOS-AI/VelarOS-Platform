/**
 * 代码符号引用（symbol:）：project:code 查到符号时签发，后续查询凭它还原 {path, symbol, container} 目标，调用方用不着后端的节点 id。
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { isString } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { CodeSymbolTarget } from '../../types/agent.js'
import { ProjectError } from '../errors.js'

const ToolName = '__project_code_symbol__'

/** 两个路径（相对 root 或绝对）是不是同一个文件。 */
export function sameCodePath(root: string, left: string, right: string): boolean {
  return resolve(root, left) === resolve(root, right)
}

/** 为一个符号目标签发 symbol: 引用，记录存在会话的上下文载荷里；宿主没给会话号或载荷存储时返回 undefined。 */
export async function saveCodeSymbolReference(
  target: CodeSymbolTarget,
  context: ProjectToolContext,
): Promise<string | undefined> {
  if (!context.contextPayloadStore || !context.sessionId) return undefined
  const serializedResult = JSON.stringify({ kind: ToolName, root: context.project.getRootPath(), target })
  const hash = createHash('sha256').update(serializedResult).digest('hex')
  await context.contextPayloadStore.put({
    sessionId: context.sessionId,
    hash,
    payloadRef: `ctx-payload:${encodeURIComponent(context.sessionId)}:${hash}`,
    toolCallId: `symbol:${hash}`,
    toolName: ToolName,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
  return `symbol:${hash}`
}

/**
 * 把代码查询的目标还原成 {path, symbol, container}：本来就是这个形状的原样返回；symbolRef 找不到、不属于当前项目或记录坏了时抛错。
 * 只给符号名、还没定到文件的目标先由调用方按名字定位（`resolveCodeTarget`），这里不收。
 */
export async function resolveCodeSymbolReference(
  input: { symbolRef: string } | CodeSymbolTarget,
  context: ProjectToolContext,
): Promise<CodeSymbolTarget> {
  if (!('symbolRef' in input)) return input
  const record = context.contextPayloadStore && context.sessionId
    ? await context.contextPayloadStore.findByHash(context.sessionId, input.symbolRef.slice('symbol:'.length))
    : undefined
  if (!record || record.toolName !== ToolName)
    throw new ProjectError('TARGET_NOT_FOUND', '符号引用不可用。', { symbolRef: input.symbolRef }, '重新查询 symbols，或传 target:{path,symbol}。')
  const value = JSON.parse(record.serializedResult)
  if (value.kind !== ToolName || value.root !== context.project.getRootPath())
    throw new ProjectError('SCOPE_VIOLATION', '符号引用不属于当前项目。')
  const target = value.target
  if (!target || !isString(target.path) || !isString(target.symbol))
    throw new ProjectError('INVALID_INPUT', '符号引用记录损坏，请重新查询 symbols。')
  return target
}
