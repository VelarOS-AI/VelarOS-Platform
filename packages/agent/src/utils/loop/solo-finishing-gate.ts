
import { isFunction, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { RunSoloFinishingGateInput, SoloFinishingGateBlockTracker, SoloFinishingGateContinueReason, SoloFinishingGateEvents, SoloFinishingGateRepeatableReason, SoloFinishingGateResult, SoloGoalFinishingState } from '../../types/loop.js'
import type { CodingSessionSnapshot } from '../../types/session.js'
import { createInternalFollowUpMessage } from '../history/internal-messages'
import { ChatRuntimeEvents } from '../wire/chat-runtime.js'

import { evaluateKernelFinalReadiness } from './final-readiness'
import { consumeSoloRuntimeGuidance } from './solo-runtime-guidance'

const RepeatedFinishingGateBlockLimit = 3

/**
 * 起一个空的「收尾门连拦」计数器：记住上一次是被哪条理由拦下的、它连着命中了几轮。
 * 整个执行共用同一个对象跨轮累加，是熔断「模型被同一条要求推回却毫无进展」的唯一依据。
 */
function createSoloFinishingGateBlockTracker(): SoloFinishingGateBlockTracker {
  return {
    reason: null,
    count: 0,
  }
}

/**
 * 把连拦计数清零。调用时机只有一个：模型这一轮真的调了工具（`SoloStreamLoop` 里 `hasToolUse` 分支）。
 * 有实际推进就不该记账，否则跨越好几轮的零散拦截会被累加成熔断，把正常会话判成 error。
 */
function resetSoloFinishingGateBlockTracker(tracker: SoloFinishingGateBlockTracker): void {
  tracker.reason = null
  tracker.count = 0
}

/**
 * 判定某条拦截理由要不要计入连拦熔断：只有三条算——验证追问、内核收尾就绪、目标状态未收束。
 * 这三条都是「把同一条要求原样推回去」，反复命中就说明模型在原地打转。
 * 其余理由（收尾提醒、后台任务、用户插话）每次带来的都是新输入，重复出现不代表空转，
 * 计进去反而会把一场活跃会话误判成 error。
 */
function isRepeatableFinishingGateReason(
  reason: SoloFinishingGateContinueReason
): reason is SoloFinishingGateRepeatableReason {
  return (
    reason === 'verification-followup' ||
    reason === 'final-readiness' ||
    reason === 'goal-status-required'
  )
}

/**
 * 把一次「收尾被拦下」翻成给主循环的裁决，并顺手维护连拦计数。
 * 不可重复的理由（或宿主没给 tracker）先清零计数再让循环续一轮；可重复的理由同理由累加、换理由归 1，
 * 连续第 3 次（`RepeatedFinishingGateBlockLimit`）不再续轮，记一条 warn 并改判
 * `error` / `repeated-finishing-gate`，把原拦截理由一并带出去。
 * 这一档是硬熔断：同一条要求推回三轮仍不满足，再推只会空烧额度，交由上层收敛执行。
 */
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

/**
 * 拼目标模式下「目标还没收束、这一轮不许结束回复」的推回消息：先报当前目标状态与目标正文
 * （压根没有目标就直说），再给四条出路——先 `goal:create` 建目标 / 继续干 /
 * `goal:update({status:"complete"})` / 确有真实阻碍就 `goal:update({status:"blocked"})`。
 * 明写 blocked 也算收束、且不必等多轮审计，是为了不把遇到硬阻碍的会话锁死在收尾环上。
 */
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

/**
 * 主 Agent 的收尾门：模型这一轮没有再调工具、看样子要结束回复时跑一遍，判「真的收」还是「推回去再跑一轮」。
 *
 * 检查顺序是固定的，每一档拦下的动作都一样——先发 turnEnd 事件、把一条内部消息压进 history，
 * 再交给 `resolveBlockedFinishingGateResult` 决定是续轮还是已经连拦三次该熔断：
 * 1. finishing 阶段的 loop reminder（改完文件的收尾提醒等）；
 * 2. 自动验证门给出的追问；
 * 3. 内核收尾就绪（`evaluateKernelFinalReadiness`，只拦验证正红）；
 * 4. 后台任务停泊——必须排在 `before-complete` 的 `takeOrSeal` 之前，否则停泊期间用户的 steer 唤不醒循环；
 * 5. 目标模式下先消费一次用户插话，再查目标是否已进终态；
 * 6. 最后一次 `before-complete` 取输入并封口。
 *
 * 中途只要 abort 信号亮起就发出中止事件并返回 `aborted`；六档全过才返回 `completed`，本次执行到此结束。
 */
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
  // 后台停泊必须先于最终输入封口，否则等待期间的用户 steer 无法唤醒。
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

  // 所有可能续轮的检查均先于最终输入边界执行。
  // 异步目标检查期间接收的输入也必须在执行结束前消费。
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
  input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
  input.log.debug('agent done', { turns: input.turn })
  return { status: 'completed' }
}

/**
 * 从不透明的 toolContext 里尽力取一份 coding session 快照供收尾判据用：结构对不上（没有
 * codingSession、或它没有 `getSnapshot`）返回 `null`；取的过程中抛错也只记一条 warn 后返回 `null`。
 * 取不到快照等于这一档放行——观测缺失不该反过来变成挡住模型收尾的理由。
 */
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
