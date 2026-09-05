import type { ModelMessage } from 'ai'

import type { StreamTurnEndPayload } from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import { isFunction, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { AutoVerificationGateResult } from '../coding'
import { evaluateKernelFinalReadiness } from '../kernel'
import type { CodingSessionSnapshot } from '../reminders'

import { createInternalFollowUpMessage } from './history'
import type { AgentRuntimeInputPort } from './RuntimeInputPort'
import type { SoloBackgroundCompletionGateResult } from './SoloBackgroundCompletionGate'
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
  /** 在 runtime input takeOrSeal 与 goal 成功提交之前，处理后台任务通知或停泊 wait-any。 */
  settlePendingBackgroundJobs?: () => Promise<SoloBackgroundCompletionGateResult>
  goalMode?: boolean
  inspectGoalState?: () => Promise<SoloGoalFinishingState>
  completeGoalOnSuccessfulFinish?: () => Promise<void>
  recordGoalCompletionAttempt?: (state: SoloGoalFinishingState) => Promise<void>
  finishingGateBlockTracker?: SoloFinishingGateBlockTracker
  log: Pick<ScopedLog, 'debug' | 'info' | 'warn'>
}

type SoloFinishingGateContinueReason =
  | 'finishing-reminder'
  | 'verification-followup'
  | 'final-readiness'
  | 'background-task'
  | 'user-guidance'
  | 'goal-status-required'

type SoloFinishingGateRepeatableReason = Extract<
  SoloFinishingGateContinueReason,
  'verification-followup' | 'final-readiness' | 'goal-status-required'
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
  /** Read-only readiness for the control plane's final goal commit. */
  canComplete?: boolean
  objective?: LooseOptional<string>
  blockedAuditTurns?: LooseOptional<number>
}

const RepeatedFinishingGateBlockLimit = 3

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

function buildGoalStatusRequiredReminder(state: SoloGoalFinishingState): string {
  const objective = state.objective?.trim()
  const statusLine = state.exists
    ? `当前目标状态：${state.status}${objective ? `；目标：${objective}` : ''}。`
    : '当前还没有活动目标。'

  return [
    '[系统] 目标模式收尾检查未通过。',
    statusLine,
    '必须继续推进，不能直接结束本次回复：',
    '- 如果还没有目标，先调用 goal:create 创建本次目标。',
    '- 如果目标尚未完成，继续读取、修改、执行或验证。',
    '- 如果目标已经真正完成，调用 goal:update({status:"complete"}) 后再收尾。',
    '- 如果确认存在无法继续推进的真实阻碍，可以自行调用 goal:update({status:"blocked"}) 后再收尾；不需要等待多轮审计。',
  ].join('\n')
}

async function runSoloFinishingGate<
  TToolContext,
  TEvents extends SoloFinishingGateEvents = SoloFinishingGateEvents,
>(
  input: RunSoloFinishingGateInput<TToolContext, TEvents>
): Promise<SoloFinishingGateResult> {
  // 「缺少理想的新证据」不是不可逆安全边界，也不能证明模型正在空转，因此不得在收尾期
  // 反复退回模型。能力规划与提示词仍可鼓励读取/验证；最终是否如实说明无证据、无能力、
  // 权限被拒或工具失败，由模型回答承担，不能再用成功工具调用作为结束资格。
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

  // 顺序不可后移：consumeSoloRuntimeGuidance(before-complete) 会原子 takeOrSeal，
  // goalMode 也会在下方提交 successful completion。后台停泊必须先于两者，
  // 否则等待期间的用户 steer 无法唤醒，或 goal 在子 Agent 结果审阅前被提前标完成。
  const backgroundGate = await input.settlePendingBackgroundJobs?.()
  if (backgroundGate && backgroundGate.status !== 'ready') {
    if (backgroundGate.status === 'interrupted' && input.abortSignal.aborted) {
      input.emitAbort()
      input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
      return { status: 'aborted' }
    }

    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    input.log.debug('turn continued by background completion gate', {
      turn: input.turn,
      status: backgroundGate.status,
      reason: backgroundGate.status === 'continue' ? backgroundGate.reason : 'runtime-input',
    })
    return resolveBlockedFinishingGateResult(input, 'background-task')
  }

  if (input.abortSignal.aborted) {
    input.emitAbort()
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return { status: 'aborted' }
  }

  // 「执行计划未收束就不许收尾」的运行时拦截已处决（2026-08-05 裁决，Desktop
  // `docs/design-principles.md` §7 第 1 类）：未收束的计划步骤是**工作流编排纪律**，
  // 不是不可逆伤害也不是已证明的空转，只许走提示词与技能文书。旧门连拦三轮会把
  // 会话判成 error，模型即使已经答完也被锁死在收尾环上。
  let shouldCompleteGoal = false
  if (input.goalMode && input.inspectGoalState) {
    const guidance = await consumeSoloRuntimeGuidance({
      turn: input.turn,
      phase: 'before-goal-check',
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
    const goalState = await input.inspectGoalState()
    shouldCompleteGoal =
      !goalState.terminal &&
      !!goalState.canComplete &&
      !!input.completeGoalOnSuccessfulFinish
    if (!goalState.terminal && !shouldCompleteGoal) {
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

  // 所有可能续轮的检查均先于最终输入边界执行。
  // 异步目标检查期间接收的输入也优先于目标提交。
  const finalGuidance = await consumeSoloRuntimeGuidance({
    turn: input.turn,
    phase: 'before-complete',
    history: input.history,
    runtimeInput: input.runtimeInput,
    consumeGuidance: input.consumeGuidance,
    log: input.log,
  })
  if (finalGuidance.consumed) {
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return resolveBlockedFinishingGateResult(input, 'user-guidance')
  }
  if (input.abortSignal.aborted) {
    input.emitAbort()
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return { status: 'aborted' }
  }
  if (shouldCompleteGoal) await input.completeGoalOnSuccessfulFinish?.()
  if (input.abortSignal.aborted) {
    input.emitAbort()
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return { status: 'aborted' }
  }

  input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
  input.log.debug('agent done', { turns: input.turn })
  return { status: 'completed' }
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
