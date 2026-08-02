import type { ToolCallBlock } from '#contracts'
import { toNullable } from '#internal/runtime'
import { asRecord, readFirstString } from '#internal/unknownJsonRecord'

const GoalStateToolNames = new Set(['goal:create', 'goal:update'])
const GoalTerminalStatuses = new Set(['complete', 'blocked'])

function getGoalRecord(block: Pick<ToolCallBlock, 'result'>): Nullable<Record<string, unknown>> {
  const resultRecord = asRecord(block.result)
  return toNullable(asRecord(resultRecord?.goal))
}

function getGoalArgs(block: Pick<ToolCallBlock, 'args'>): Nullable<Record<string, unknown>> {
  return toNullable(asRecord(block.args))
}

export function isGoalToolStateToolName(toolName: string): boolean {
  return GoalStateToolNames.has(toolName)
}

export function getGoalToolBlockObjective(
  block: Pick<ToolCallBlock, 'args' | 'result'>
): Nullable<string> {
  const goalRecord = getGoalRecord(block)
  const argsRecord = getGoalArgs(block)

  return readFirstString(goalRecord?.objective, argsRecord?.objective)
}

export function getGoalToolBlockStatus(
  block: Pick<ToolCallBlock, 'args' | 'result'> & { toolName?: string }
): Nullable<string> {
  if (!isGoalToolStateToolName(block.toolName ?? '')) return null

  const resultRecord = asRecord(block.result)
  const goalRecord = getGoalRecord(block)
  const argsRecord = getGoalArgs(block)
  const status = readFirstString(goalRecord?.status, resultRecord?.status, argsRecord?.status)

  if (status) return status
  if (block.toolName === 'goal:create' && getGoalToolBlockObjective(block)) return 'active'
  if (block.toolName === 'goal:update' && (argsRecord?.objective || argsRecord?.constraints))
    return 'active'

  return null
}

export function isGoalToolBlockActive(
  block: Pick<ToolCallBlock, 'args' | 'error' | 'result'> & { toolName?: string }
): boolean {
  if (!isGoalToolStateToolName(block.toolName ?? '') || block.error) return false

  const status = getGoalToolBlockStatus(block)
  if (status && GoalTerminalStatuses.has(status)) return false

  return status === 'active'
}

export function getGoalToolBlockSignature(
  block: Pick<ToolCallBlock, 'args' | 'result' | 'toolCallId' | 'error'> & { toolName?: string }
): string {
  const objective = getGoalToolBlockObjective(block) ?? ''
  const status = getGoalToolBlockStatus(block) ?? ''

  return [block.toolCallId, objective, status, block.error ?? ''].join('::')
}
