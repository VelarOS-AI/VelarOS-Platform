/**
 * 上下文治理 v2 配置面（kernel 侧类型与默认值单源）。
 *
 * 实验臂 = 同一引擎的预设，不是第二条实现路径：`A0-truncation` / `A1-mechanical` /
 * `A2-distill-always` / `A3-adaptive` 全部只改本结构的字段。壳侧接线（设置页 / 会话覆盖）
 * 是 B1 的事，本文件只提供类型、默认值与宽容解析。
 *
 * 宽容纪律（工具 UX 八铁律同款）：解析**钳制不拒绝**——越界值夹到合法区间并保持可用，
 * 不因为一个手滑的配置把整条治理链路打死。
 */
import { isFiniteNumber, isPresent } from '@velaros-ai/core'

/** I2 蒸馏档位。`off`=纯机械；`aux`=辅助模型（默认）；`main`=主模型；`adaptive`=按需（论文主臂）。 */
export type ContextDistillInstrument = 'off' | 'aux' | 'main' | 'adaptive'

export interface ContextAdmissionConfig {
  /** 工具结果超过该字符数直接以 EXCERPT 准入（沿用 v1 句柄化现值 24K）。 */
  inlineMaxChars: number
  /**
   * 单条 user 正文超过该字符数直接以 EXCERPT 准入（v1 `MaxUserMessageInlineChars` 安全阀，
   * 48K，语义逐字对齐）。与工具结果分开一档：一条用户指令的信息密度远高于一份工具输出，
   * 用同一个 24K 门会把长需求书当日志砍。
   */
  userInlineMaxChars: number
  /**
   * EXCERPT 摘录的字符预算。默认等于 `inlineMaxChars`——**这就是 v1 现行语义**
   * （`tool-output-store` 的 preview 预算 == 句柄化阈值），B0 不动它。
   * 单列成旋钮是为了 B1 能扫参：两者相等时 25K 的结果只省 1K，是个已知的钝角。
   */
  excerptMaxChars: number
}

export interface ContextInstrumentConfig {
  /** I1 规则骨架（免费、保关键场）。 */
  skeleton: boolean
  /** I2 LLM 蒸馏档位。 */
  distill: ContextDistillInstrument
}

export interface ContextGovernanceConfig {
  /** 治理窗口上限：G = min(模型窗口, cap)。 */
  cap: number
  /** 尾保护轮数：最近若干轮对话恒以全文投影。 */
  tailProtectTurns: number
  /** epoch 触发水位（占 G 的百分比）。 */
  epochTriggerPercent: number
  /** epoch 目标水位（占 G 的百分比）。 */
  epochTargetPercent: number
  /** 反空转：预计节省低于该百分比则跳过本次 epoch。 */
  minEpochSavingPercent: number
  admission: ContextAdmissionConfig
  instruments: ContextInstrumentConfig
  /** 活动尾的 context-dashboard 块（模型本体感知）。 */
  dashboard: boolean
  /**
   * epoch 批处理开关（隐藏开关，RQ2 缓存对照专用）。
   * false = 退化成逐轮应用降级，用来量化"批处理省下多少缓存重建"。
   */
  epochBatching: boolean
}

export const DefaultContextGovernanceConfig: ContextGovernanceConfig = {
  cap: 200_000,
  tailProtectTurns: 2,
  epochTriggerPercent: 70,
  epochTargetPercent: 40,
  minEpochSavingPercent: 10,
  admission: { inlineMaxChars: 24_000, userInlineMaxChars: 48_000, excerptMaxChars: 24_000 },
  // distill 默认 'off' 到 B2 落地为止：I2 尚未实现，默认到一条恒降级路径只会刷警告。
  // B2 交付后本默认切 'aux'（设计 §7 的终态默认）。
  instruments: { skeleton: true, distill: 'off' },
  dashboard: true,
  epochBatching: true,
}

const DistillInstruments: ContextDistillInstrument[] = ['off', 'aux', 'main', 'adaptive']

/** 实验臂预设：四臂同引擎，差异只在器械档位（validation-plan §5 度量沿用）。 */
export const ContextGovernancePresets = {
  'A0-truncation': {
    instruments: { skeleton: false, distill: 'off' },
  },
  'A1-mechanical': {
    instruments: { skeleton: true, distill: 'off' },
  },
  'A2-distill-always': {
    instruments: { skeleton: true, distill: 'aux' },
  },
  'A3-adaptive': {
    instruments: { skeleton: true, distill: 'adaptive' },
  },
} as const satisfies Record<string, ContextGovernanceConfigInput>

export type ContextGovernancePresetName = keyof typeof ContextGovernancePresets

export interface ContextGovernanceConfigInput {
  cap?: LooseOptional<number>
  tailProtectTurns?: LooseOptional<number>
  epochTriggerPercent?: LooseOptional<number>
  epochTargetPercent?: LooseOptional<number>
  minEpochSavingPercent?: LooseOptional<number>
  admission?: LooseOptional<{
    inlineMaxChars?: LooseOptional<number>
    userInlineMaxChars?: LooseOptional<number>
    excerptMaxChars?: LooseOptional<number>
  }>
  instruments?: LooseOptional<{
    skeleton?: LooseOptional<boolean>
    distill?: LooseOptional<string>
  }>
  dashboard?: LooseOptional<boolean>
  epochBatching?: LooseOptional<boolean>
}

/**
 * 宽容解析：缺省回落默认值、越界钳制、未知蒸馏档回落默认档。
 * 另有一条语义不变量——目标水位必须严格低于触发水位，否则 epoch 会当场空转，
 * 这里把目标钳到触发水位以下而不是报错。
 */
export function resolveContextGovernanceConfig(
  input?: LooseOptional<ContextGovernanceConfigInput>
): ContextGovernanceConfig {
  const defaults = DefaultContextGovernanceConfig
  const epochTriggerPercent = clampPercent(input?.epochTriggerPercent, defaults.epochTriggerPercent)
  const epochTargetPercent = Math.min(
    clampPercent(input?.epochTargetPercent, defaults.epochTargetPercent),
    Math.max(1, epochTriggerPercent - 1)
  )
  const inlineMaxChars = clampInteger(
    input?.admission?.inlineMaxChars,
    defaults.admission.inlineMaxChars,
    200,
    1_000_000
  )

  return {
    cap: clampInteger(input?.cap, defaults.cap, 1_000, 10_000_000),
    tailProtectTurns: clampInteger(input?.tailProtectTurns, defaults.tailProtectTurns, 0, 100),
    epochTriggerPercent,
    epochTargetPercent,
    minEpochSavingPercent: clampPercent(
      input?.minEpochSavingPercent,
      defaults.minEpochSavingPercent
    ),
    admission: {
      inlineMaxChars,
      userInlineMaxChars: clampInteger(
        input?.admission?.userInlineMaxChars,
        defaults.admission.userInlineMaxChars,
        1_000,
        2_000_000
      ),
      excerptMaxChars: clampInteger(
        input?.admission?.excerptMaxChars,
        inlineMaxChars,
        100,
        1_000_000
      ),
    },
    instruments: {
      skeleton: input?.instruments?.skeleton ?? defaults.instruments.skeleton,
      distill: resolveDistillInstrument(input?.instruments?.distill),
    },
    dashboard: input?.dashboard ?? defaults.dashboard,
    epochBatching: input?.epochBatching ?? defaults.epochBatching,
  }
}

/** 预设 → 完整配置（预设只覆盖器械档，其余走默认）。 */
export function resolveContextGovernancePreset(
  name: ContextGovernancePresetName
): ContextGovernanceConfig {
  return resolveContextGovernanceConfig(ContextGovernancePresets[name])
}

/** 治理窗口 G = min(模型可用窗口, cap)。窗口未知时退化为 cap。 */
export function resolveGovernanceWindowTokens(
  config: ContextGovernanceConfig,
  modelWindowTokens: LooseOptional<number>
): number {
  if (!isFiniteNumber(modelWindowTokens) || modelWindowTokens <= 0) return config.cap
  return Math.min(Math.floor(modelWindowTokens), config.cap)
}

function resolveDistillInstrument(value: LooseOptional<string>): ContextDistillInstrument {
  const normalized = value?.trim().toLowerCase()
  const matched = DistillInstruments.find((instrument) => instrument === normalized)
  return matched ?? DefaultContextGovernanceConfig.instruments.distill
}

function clampInteger(
  value: LooseOptional<number>,
  fallback: number,
  min: number,
  max: number
): number {
  if (!isPresent(value) || !isFiniteNumber(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function clampPercent(value: LooseOptional<number>, fallback: number): number {
  return clampInteger(value, fallback, 1, 100)
}
