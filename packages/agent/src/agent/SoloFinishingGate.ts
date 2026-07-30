import type { ModelMessage } from 'ai'

import { isArray,isEmpty, isFunction, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'
import type {
  ExecutionTaskPlanStep,
  StreamTurnEndPayload,
} from '@velaros-ai/core/types'
import { ChatRuntimeEvents } from '@velaros-ai/core/types'

import type { AutoVerificationGateResult } from '../coding'
import { evaluateKernelFinalReadiness } from '../kernel'
import type { CodingSessionSnapshot } from '../reminders'

import { createInternalFollowUpMessage } from './history'
import type { AgentRuntimeInputPort } from './RuntimeInputPort'
import { consumeSoloRuntimeGuidance } from './SoloRuntimeGuidance'

interface SoloFinishingGateEvents {
  emitRuntime(payload: StreamTurnEndPayload): void
}

interface RunSoloFinishingGateInput<
  TToolContext,
  TEvents extends SoloFinishingGateEvents = SoloFinishingGateEvents,
> {
  turn: number
  history: ModelMessage[]
  toolContext: TToolContext
  events: TEvents
  abortSignal: AbortSignal
  emitAbort(): void
  tickLoopReminders(input: {
    mode: 'solo'
    phase: 'finishing'
    toolContext: TToolContext
  }): Promise<string[]>
  runAutomaticVerification(input: {
    toolContext: TToolContext
  }): Promise<AutoVerificationGateResult>
  runtimeInput?: AgentRuntimeInputPort
  consumeGuidance?: () => Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  goalMode?: boolean
  inspectGoalState?: () => Promise<SoloGoalFinishingState>
  recordGoalCompletionAttempt?: (state: SoloGoalFinishingState) => Promise<void>
  finishingGateBlockTracker?: SoloFinishingGateBlockTracker
  log: Pick<ScopedLog, 'debug' | 'info' | 'warn'>
}

type SoloFinishingGateContinueReason =
  | 'finishing-reminder'
  | 'verification-followup'
  | 'final-readiness'
  | 'user-guidance'
  | 'execution-plan-required'
  | 'goal-status-required'

type SoloFinishingGateRepeatableReason = Extract<
  SoloFinishingGateContinueReason,
  'verification-followup' | 'final-readiness' | 'execution-plan-required' | 'goal-status-required'
>

interface SoloFinishingGateBlockTracker {
  reason: Nullable<SoloFinishingGateRepeatableReason>
  count: number
}

type SoloFinishingGateResult =
  | {
      status: 'continue'
      reason: SoloFinishingGateContinueReason
    }
  | { status: 'aborted' }
  | { status: 'completed' }
  | {
      status: 'error'
      reason: 'repeated-finishing-gate'
      blockedReason: SoloFinishingGateRepeatableReason
    }

type SoloGoalFinishingStatus = 'missing' | 'active' | 'complete' | 'blocked'

interface SoloGoalFinishingState {
  exists: boolean
  terminal: boolean
  status: SoloGoalFinishingStatus
  objective?: LooseOptional<string>
  blockedAuditTurns?: LooseOptional<number>
}

interface SoloExecutionPlanFinishingState {
  total: number
  unresolved: Array<Pick<ExecutionTaskPlanStep, 'id' | 'title' | 'status'>>
}

const RepeatedFinishingGateBlockLimit = 3

function isExecutionPlanStepResolved(step: Pick<ExecutionTaskPlanStep, 'status'>): boolean {
  return step.status === 'completed' || step.status === 'skipped' || step.status === 'failed'
}

function createSoloFinishingGateBlockTracker(): SoloFinishingGateBlockTracker {
  return {
    reason: null,
    count: 0,
  }
}

function resetSoloFinishingGateBlockTracker(tracker: SoloFinishingGateBlockTracker): void {
  tracker.reason = null
  tracker.count = 0
}

function isRepeatableFinishingGateReason(
  reason: SoloFinishingGateContinueReason
): reason is SoloFinishingGateRepeatableReason {
  return (
    reason === 'verification-followup' ||
    reason === 'final-readiness' ||
    reason === 'execution-plan-required' ||
    reason === 'goal-status-required'
  )
}

function resolveBlockedFinishingGateResult(
  input: Pick<RunSoloFinishingGateInput<unknown>, 'finishingGateBlockTracker' | 'log' | 'turn'>,
  reason: SoloFinishingGateContinueReason
): SoloFinishingGateResult {
  const tracker = input.finishingGateBlockTracker
  if (!tracker || !isRepeatableFinishingGateReason(reason)) {
    if (tracker) resetSoloFinishingGateBlockTracker(tracker)
    return { status: 'continue', reason }
  }

  if (tracker.reason === reason) {
    tracker.count += 1
  } else {
    tracker.reason = reason
    tracker.count = 1
  }

  if (tracker.count >= RepeatedFinishingGateBlockLimit) {
    input.log.warn('turn stopped by repeated finishing gate block', {
      turn: input.turn,
      reason,
      count: tracker.count,
    })
    return {
      status: 'error',
      reason: 'repeated-finishing-gate',
      blockedReason: reason,
    }
  }

  return { status: 'continue', reason }
}

function buildExecutionPlanRequiredReminder(state: SoloExecutionPlanFinishingState): string {
  const unresolved = state.unresolved
    .slice(0, 6)
    .map((step, index) => `${index + 1}. [${step.status}] ${step.title}`)
    .join('\n')

  return [
    '[系统] 执行计划收尾检查未通过。',
    `当前计划共有 ${state.total} 步，仍有 ${state.unresolved.length} 步未收束：`,
    unresolved,
    '必须继续推进这些步骤；如果某步已经完成、跳过或废弃，请先调用 update_plan 更新完整计划状态，再尝试收尾。',
  ].join('\n')
}

function buildGoalStatusRequiredReminder(state: SoloGoalFinishingState): string {
  const objective = state.objective?.trim()
  const statusLine = state.exists
    ? `当前目标状态：${state.status}${objective ? `；目标：${objective}` : ''}。`
    : '当前还没有活动目标。'

  return [
    '[系统] 目标模式收尾检查未通过。',
    statusLine,
    '必须继续推进，不能直接结束本次回复：',
    '- 如果还没有目标，先调用 create_goal 创建本次目标。',
    '- 如果目标尚未完成，继续读取、修改、执行或验证。',
    '- 如果目标已经真正完成，调用 update_goal({status:"complete"}) 后再收尾。',
    '- 如果确认存在无法继续推进的真实阻碍，可以自行调用 update_goal({status:"blocked"}) 后再收尾；不需要等待多轮审计。',
  ].join('\n')
}

async function runSoloFinishingGate<
  TToolContext,
  TEvents extends SoloFinishingGateEvents = SoloFinishingGateEvents,
>(
  input: RunSoloFinishingGateInput<TToolContext, TEvents>
): Promise<SoloFinishingGateResult> {
  const finishingReminders = await input.tickLoopReminders({
    mode: 'solo',
    phase: 'finishing',
    toolContext: input.toolContext,
  })
  if (finishingReminders.length > 0) {
    for (const reminder of finishingReminders) {
      input.history.push(createInternalFollowUpMessage(reminder))
    }
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    input.log.debug('turn end with post-edit reminder', { turn: input.turn })
    return resolveBlockedFinishingGateResult(input, 'finishing-reminder')
  }

  const verificationGate = await input.runAutomaticVerification({
    toolContext: input.toolContext,
  })

  if (verificationGate.followupMessage) {
    input.history.push(createInternalFollowUpMessage(verificationGate.followupMessage))
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    input.log.debug('turn blocked by verification gate', { turn: input.turn })
    return resolveBlockedFinishingGateResult(input, 'verification-followup')
  }

  const snapshot = readCodingSessionSnapshot(input.toolContext, input.log)
  const finalReadiness = evaluateKernelFinalReadiness({
    snapshot,
  })
  if (!finalReadiness.allowed && finalReadiness.followupMessage) {
    input.history.push(createInternalFollowUpMessage(finalReadiness.followupMessage))
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    input.log.debug('turn blocked by final readiness gate', {
      turn: input.turn,
      reason: finalReadiness.reason,
      audit: finalReadiness.audit,
    })
    return resolveBlockedFinishingGateResult(input, 'final-readiness')
  }

  if (input.abortSignal.aborted) {
    input.emitAbort()
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return { status: 'aborted' }
  }

  const guidance = await consumeSoloRuntimeGuidance({
    turn: input.turn,
    phase: 'before-complete',
    history: input.history,
    runtimeInput: input.runtimeInput,
    consumeGuidance: input.consumeGuidance,
    log: input.log,
  })
  if (guidance.consumed) {
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    input.log.debug('turn continued by user guidance', { turn: input.turn })
    return resolveBlockedFinishingGateResult(input, 'user-guidance')
  }

  const executionPlanState = readExecutionPlanFinishingState(input.toolContext, input.log)
  if (executionPlanState && !isEmpty(executionPlanState.unresolved)) {
    input.history.push(createInternalFollowUpMessage(
      buildExecutionPlanRequiredReminder(executionPlanState)
    ))
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    input.log.debug('turn continued by execution plan gate', {
      turn: input.turn,
      unresolvedSteps: executionPlanState.unresolved.length,
    })
    return resolveBlockedFinishingGateResult(input, 'execution-plan-required')
  }

  if (input.goalMode && input.inspectGoalState) {
    const goalState = await input.inspectGoalState()
    if (!goalState.terminal) {
      await input.recordGoalCompletionAttempt?.(goalState)
      input.history.push(createInternalFollowUpMessage(buildGoalStatusRequiredReminder(goalState)))
      input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
      input.log.debug('turn continued by goal status gate', {
        turn: input.turn,
        status: goalState.status,
      })
      return resolveBlockedFinishingGateResult(input, 'goal-status-required')
    }
  }

  input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
  input.log.debug('agent done', { turns: input.turn })
  return { status: 'completed' }
}

function readExecutionPlanFinishingState(
  toolContext: unknown,
  log: Pick<ScopedLog, 'warn'>
): Nullable<SoloExecutionPlanFinishingState> {
  if (!isPlainObject(toolContext)) return null
  if (!hasExecutionPlanMaintenanceAccess(toolContext, log)) return null

  const execution = toolContext.execution
  if (!isPlainObject(execution) || !isFunction(execution.getCurrentPlan)) return null

  try {
    const plan = execution.getCurrentPlan() as ExecutionTaskPlanStep[]
    if (!isArray(plan) || isEmpty(plan)) return null

    return {
      total: plan.length,
      unresolved: plan
        .filter((step) => !isExecutionPlanStepResolved(step))
        .map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
        })),
    }
  } catch (error) {
    log.warn('execution plan readiness read failed', {
      error: AppError.getMessage(error),
    })
    return null
  }
}

function hasExecutionPlanMaintenanceAccess(
  toolContext: unknown,
  log: Pick<ScopedLog, 'warn'>
): boolean {
  if (!isPlainObject(toolContext)) return false
  const codingSession = toolContext.codingSession
  if (!isPlainObject(codingSession) || !isFunction(codingSession.hasPromptFeatureAccess)) return false

  try {
    return Boolean(codingSession.hasPromptFeatureAccess('plan'))
  } catch (error) {
    log.warn('execution plan access read failed', {
      error: AppError.getMessage(error),
    })
    return false
  }
}

function readCodingSessionSnapshot(
  toolContext: unknown,
  log: Pick<ScopedLog, 'warn'>
): Nullable<CodingSessionSnapshot> {
  if (!isPlainObject(toolContext)) return null
  const codingSession = toolContext.codingSession
  if (!isPlainObject(codingSession) || !isFunction(codingSession.getSnapshot)) return null

  try {
    return codingSession.getSnapshot() as CodingSessionSnapshot
  } catch (error) {
    log.warn('final readiness snapshot read failed', {
      error: AppError.getMessage(error),
    })
    return null
  }
}

export {
  createSoloFinishingGateBlockTracker,
  resetSoloFinishingGateBlockTracker,
  runSoloFinishingGate,
}
export type {
  RunSoloFinishingGateInput,
  SoloFinishingGateBlockTracker,
  SoloFinishingGateContinueReason,
  SoloFinishingGateEvents,
  SoloFinishingGateRepeatableReason,
  SoloFinishingGateResult,
  SoloGoalFinishingState,
}
