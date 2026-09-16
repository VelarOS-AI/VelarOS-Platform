// 域：一轮被打断之后「还救不救、怎么跟模型说」的纯判定与提示词。
//
// 判定只看事实（中止了没有、已经救过几次、错误是哪一类），提示词只拼字符串；真正的重发、
// 历史追加与状态收敛都在 impl/loop 的类里。文案是模型面，改一个字就是改模型看到的内容。
import { isReasoningOnlyEmptyResponseError } from '../stream/empty-stream-recovery'

/**
 * 判本轮是不是被「运行时插话」截断的。
 *
 * 只有三件事同时成立才算：执行没有被中止（那是另一条路）、插话信号已亮、本轮还没有把任何工具调用
 * 派给执行器。最后一条是硬条件：工具一旦派出去就可能已经产生副作用，这时按「被引导截断」收尾会让
 * 历史里留下没有结果的工具调用。
 */
export function wasStreamTurnInterruptedByRuntimeInput(
  args: { abortSignal: AbortSignal; runtimeInputInterruptSignal?: LooseOptional<AbortSignal> },
  turnState: { hasDispatchedToolUse?: boolean }
): boolean {
  return !!(
    !args.abortSignal.aborted &&
    args.runtimeInputInterruptSignal?.aborted &&
    !turnState.hasDispatchedToolUse
  )
}

/**
 * 判「模型只出了思考、没给可见答复」要不要再要一次：已中止或自纠次数用尽就不再要，
 * 否则交给 `isReasoningOnlyEmptyResponseError` 按错误形态定夺。主面传 `stream`，子 Agent 面传 `query`。
 */
export function shouldRecoverReasoningOnlyEmptyResponse(input: {
  /** 本轮抛出来的原始错误。 */
  error: unknown
  /** 哪条链路出的事，决定错误来源标签怎么匹配。 */
  phase: 'stream' | 'query'
  /** 本轮是否已经被中止；中止优先于一切恢复。 */
  aborted: boolean
  /** 这一轮已经要过几次可见答复。 */
  recoveryAttempts: number
  /** 最多要几次，到了就放弃并把错误抛出去。 */
  maxAttempts: number
}): boolean {
  if (input.aborted) return false
  if (input.recoveryAttempts >= input.maxAttempts) return false

  return isReasoningOnlyEmptyResponseError(input.error, input.phase)
}

/** 主会话的「只出思考」纠正提示：要求用普通正文补一个可见答复，需要工具就重发一次完整调用。 */
export function buildPrimaryReasoningOnlyVisibleAnswerRecoveryPrompt(): string {
  return [
    '上一条回复只有思考过程，没有给用户任何可见答复。',
    '现在用普通正文补一个可见答复。',
    '不要再只输出思考过程。',
    '如果还需要调用工具，请重新发一次参数完整的调用；否则直接作答。',
  ].join('\n')
}

/** 子 Agent 的「只出思考」纠正提示：与主面同款，只是把收信人从用户换成上级 Agent。 */
export function buildSubAgentReasoningOnlyVisibleAnswerRecoveryPrompt(): string {
  return [
    '上一条回复只有思考过程，没有给主 Agent 任何可见答复。',
    '现在用普通正文补一个可见答复。',
    '不要再只输出思考过程。',
    '如果还需要调用工具，请重新发一次参数完整的调用；否则直接作答。',
  ].join('\n')
}

/**
 * 主会话流被瞬断打断后的续写提示。
 *
 * 按「已展示的正文有没有保进历史」与「有没有半截工具调用」分支：保住了就让模型接着写、别重复；
 * 没保住也没有半截工具调用就让它直接继续答；有半截工具调用要说清那次调用**没有执行**、没有结果，
 * 需要的话重发一次完整调用——不说清楚，模型会以为工具已经跑过。
 */
export function buildInterruptedStreamRecoveryPrompt(
  partial: { hasPendingToolCalls: boolean },
  appendedAssistant: boolean
): string {
  const lines = [
    '上一条回复的输出流被供应方的一次瞬时连接故障打断了。',
  ]

  if (appendedAssistant) {
    lines.push(
      [
        '已经输出的可见正文保留在对话历史里。',
        '从那里接着写。',
        '不要重复已经输出过的内容。',
      ].join('')
    )
  } else if (!partial.hasPendingToolCalls) {
    lines.push(
      [
        '现在继续作答。',
        '不要重复任何可能已经输出过的可见正文。',
      ].join('')
    )
  }

  if (partial.hasPendingToolCalls) {
    lines.push(
      [
        '有一次工具调用刚开始，输出流就在 VelarOS 收下它之前断了。',
        '那次调用没有执行，也没有任何工具结果。',
        '如果还需要它，请重新发一次参数完整的调用。',
      ].join('')
    )
  }

  lines.push('现在继续。')
  return lines.join('\n')
}

/**
 * 子 Agent 的收尾提醒：到运行软上限（时间或步数，先到先触发）后注入一次。
 * 要求模型立刻停手、用一段话汇报进展，并在开头注明是因为运行上限提前收尾——父 Agent 靠这句话
 * 判断要不要续派。`startedAt` 是本次委派的起始时间戳（epoch ms），用来算出已跑的分钟数。
 */
export function buildSubAgentWindDownReminder(startedAt: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
  return [
    `[系统] 你已运行约 ${minutes} 分钟或较多步骤，达到本次子任务的运行软上限。`,
    '请立即停止调用任何工具，用一段话向上级汇报：',
    '1) 已完成了什么；2) 当前卡在哪一步/还差什么；3) 建议的下一步。',
    '在汇报开头注明「因运行上限提前收尾」，然后结束本次回复。',
  ].join('\n')
}
