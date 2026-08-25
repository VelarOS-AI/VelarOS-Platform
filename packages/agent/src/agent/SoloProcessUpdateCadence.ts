interface SoloProcessUpdateCadenceState {
  consecutiveToolOnlyTurns: number
}

interface AdvanceSoloProcessUpdateCadenceInput {
  hasVisibleText: boolean
}

interface AdvanceSoloProcessUpdateCadenceResult {
  state: SoloProcessUpdateCadenceState
  reminder: Nullable<string>
}

const SilentToolTurnThreshold = 2

const VisibleProcessUpdateReminder = [
  '[system] 你已经连续完成了一组只有思考和工具调用的回合。',
  '继续执行前，先用一两句话向用户输出可见的阶段进展：只说新增结果、方向变化和下一步；不要逐工具播报，不要复述思考，也不要只说“仍在处理”。',
  '阶段汇报后可以在同一条回复中继续调用工具。',
].join('\n')

function createSoloProcessUpdateCadenceState(): SoloProcessUpdateCadenceState {
  return { consecutiveToolOnlyTurns: 0 }
}

/**
 * 阶段沟通的运行时兜底：信息价值仍由模型判断，只在连续两个纯工具回合后提醒一次。
 * 模型输出可见进展即复位；若忽略提醒并继续纯工具执行，下一轮继续提醒而不静默放行。
 */
function advanceSoloProcessUpdateCadence(
  state: SoloProcessUpdateCadenceState,
  input: AdvanceSoloProcessUpdateCadenceInput
): AdvanceSoloProcessUpdateCadenceResult {
  if (input.hasVisibleText)
    return {
      state: createSoloProcessUpdateCadenceState(),
      reminder: null,
    }

  const consecutiveToolOnlyTurns = state.consecutiveToolOnlyTurns + 1
  return {
    state: { consecutiveToolOnlyTurns },
    reminder:
      consecutiveToolOnlyTurns >= SilentToolTurnThreshold ? VisibleProcessUpdateReminder : null,
  }
}

export {
  advanceSoloProcessUpdateCadence,
  createSoloProcessUpdateCadenceState,
  VisibleProcessUpdateReminder,
}
export type { SoloProcessUpdateCadenceState }
