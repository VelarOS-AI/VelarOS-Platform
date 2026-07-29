import type { ContentBlock, ToolCallBlock } from '#contracts'
import { isArray, isEmpty } from '#internal/runtime'
import { asRecord, readFirstString, readString } from '#internal/unknownJsonRecord'

export interface PlanToolStepPreview {
  id: Nullable<string>
  title: string
  objective: Nullable<string>
  status: string
}

/** 一条助手消息只把最后一次计划快照作为可见卡片；更早的过程快照仍归入工具活动。 */
export function getLatestPlanToolCallId(blocks: readonly ContentBlock[]): Nullable<string> {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]

    if (block?.type === 'tool-call' && block.toolName === 'update_plan') return block.toolCallId
  }

  return null
}

function readPlanSteps(value: any): PlanToolStepPreview[] {
  if (!isArray(value)) return []

  return value.flatMap((item): PlanToolStepPreview[] => {
    const record = asRecord(item)
    const title = readFirstString(record?.title, record?.step)

    if (!title) return []

    return [
      {
        id: readString(record, 'id'),
        title,
        objective: readString(record, 'objective'),
        status: readString(record, 'status') ?? 'pending',
      },
    ]
  })
}

export function getPlanToolBlockSteps(
  block: Pick<ToolCallBlock, 'args' | 'result'>
): PlanToolStepPreview[] {
  const resultRecord = asRecord(block.result)
  const resultSteps = readPlanSteps(resultRecord?.plan)

  return !isEmpty(resultSteps) ? resultSteps : readPlanSteps(block.args.plan)
}

export function getPlanToolBlockExplanation(
  block: Pick<ToolCallBlock, 'args' | 'result'>
): Nullable<string> {
  const resultRecord = asRecord(block.result)
  return readFirstString(resultRecord?.explanation, block.args?.explanation)
}

export function arePlanToolStepsCompleted(steps: readonly PlanToolStepPreview[]): boolean {
  return !isEmpty(steps) && steps.every((step) => isTerminalPlanStepStatus(step.status))
}

export function hasFailedPlanToolStep(steps: readonly PlanToolStepPreview[]): boolean {
  return steps.some((step) => step.status === 'failed')
}

export function isPlanToolBlockComplete(
  block: Pick<ToolCallBlock, 'args' | 'result'> & Partial<Pick<ToolCallBlock, 'error'>>
): boolean {
  if (block.error) return true

  return arePlanToolStepsCompleted(getPlanToolBlockSteps(block))
}

export function getPlanToolBlockSignature(
  block: Pick<ToolCallBlock, 'args' | 'result' | 'toolCallId' | 'error'>
): string {
  const steps = getPlanToolBlockSteps(block)
  const explanation = getPlanToolBlockExplanation(block) ?? ''
  const stepSignature = steps
    .map((step) => [step.id ?? '', step.title, step.objective ?? '', step.status].join('|'))
    .join('||')

  return [block.toolCallId, explanation, block.error ?? '', stepSignature].join('::')
}

function isTerminalPlanStepStatus(status: string): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed'
}
