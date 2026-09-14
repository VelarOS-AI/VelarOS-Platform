import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { isString } from '@velaros-ai/core'

import type { ProjectToolContext } from '../agent/Types.js'
import { ProjectError } from '../errors.js'
import type { ProjectCodeTarget } from '../project-code-contracts.js'

export interface CodeSymbolTarget {
  path: string
  symbol: string
  container?: string
  line?: number
  nodeId?: string
}

const ToolName = '__project_code_symbol__'

export function sameCodePath(root: string, left: string, right: string): boolean {
  return resolve(root, left) === resolve(root, right)
}

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

export async function resolveCodeSymbolReference(
  input: ProjectCodeTarget,
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
