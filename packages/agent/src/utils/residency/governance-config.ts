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

import type { ContextDistillConfig, ContextDistillInstrument, ContextGovernanceConfig, ContextGovernanceConfigInput,ContextGovernancePresetName } from '../../types/residency.js'

export const DefaultContextGovernanceConfig: ContextGovernanceConfig = {
  cap: 200_000,
  tailProtectTurns: 2,
  tailProtectMaxRecords: 16,
  epochTriggerPercent: 100,
  epochTargetPercent: 90,
  minEpochSavingPercent: 10,
  admission: { inlineMaxChars: 24_000, userInlineMaxChars: 48_000, excerptMaxChars: 24_000 },
  // B2 起默认 'aux'（设计 §7 的终态默认）：宿主没注入蒸馏器时它自动退化为纯机械
  // （`skipReason: 'no-distiller'`），所以默认开档对 headless / 测试 / 无模型环境是安全的。
  instruments: { skeleton: true, distill: 'aux' },
  // 逐字沿用 B1 起 `GovernanceEpoch.ts` 里的模块常量值：搬进配置面是为了 B4 能扫，不是改行为。
  eviction: {
    lowAnchorDensityPerKiloChar: 2,
    staleRefetchableTurnDistance: 2,
    staleRefetchableRecordDistance: 24,
    payloadBackedTurnDistance: 6,
    payloadBackedRecordDistance: 24,
  },
  faultRecovery: {
    baseWarmLeaseTurns: 6,
    maxWarmLeaseTurns: 48,
    stickyAfterFaults: 3,
  },
  // 同上：逐字沿用 B1 起 `ContextGovernanceSession.ts` 里的 HandoffLowSavingStreak / HandoffOccupancyPercent。
  handoff: { lowSavingStreak: 2, occupancyPercent: 35 },
  distillation: {
    maxResidentSummaries: 8,
    maxSegmentsPerEpoch: 1,
    maxInputChars: 48_000,
    targetChars: 2_400,
    timeoutMs: 45_000,
    maxRequiredAnchors: 24,
    minSegmentChars: 4_000,
    adaptive: {
      minShortfallPercent: 5,
      minNarrativeChars: 8_000,
      maxAnchorDensityPerKiloChar: 6,
      minSavingToCostRatio: 1.5,
      amortizationRequests: 5,
    },
  },
  dashboard: true,
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
} as const satisfies Record<ContextGovernancePresetName, ContextGovernanceConfigInput>

export const ContextGovernancePresetNames = Object.keys(
  ContextGovernancePresets
) as ContextGovernancePresetName[]

/**
 * 反查：当前生效配置对应哪条实验臂。
 *
 * B3 电池必须能**从活着的治理器**读回"我现在跑的是哪条臂"——只断言"我发过 set_arm 请求"
 * 等于用意图冒充事实，一次静默失败的配置写入就会把整个矩阵变成同一条臂的四份重复数据。
 * 判据只看 `instruments`：预设本来就只改这两个字段，其余旋钮（B4 扫参）不改变臂身份。
 * 返回 null = 器械组合不属于任何预设（自定义配置），这本身也是必须能被看见的事实。
 */
export function resolveContextGovernanceArmName(
  config: ContextGovernanceConfig
): Nullable<ContextGovernancePresetName> {
  for (const name of ContextGovernancePresetNames) {
    const preset = ContextGovernancePresets[name].instruments
    if (
      preset.skeleton === config.instruments.skeleton &&
      preset.distill === config.instruments.distill
    )
      return name
  }

  return null
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
  const baseWarmLeaseTurns = clampInteger(
    input?.faultRecovery?.baseWarmLeaseTurns,
    defaults.faultRecovery.baseWarmLeaseTurns,
    1,
    10_000
  )
  const maxWarmLeaseTurns = Math.max(
    baseWarmLeaseTurns,
    clampInteger(
      input?.faultRecovery?.maxWarmLeaseTurns,
      defaults.faultRecovery.maxWarmLeaseTurns,
      1,
      100_000
    )
  )

  return {
    cap: clampInteger(input?.cap, defaults.cap, 1_000, 10_000_000),
    tailProtectTurns: clampInteger(input?.tailProtectTurns, defaults.tailProtectTurns, 0, 100),
    // 上界给到 100 万 = "只按轮算"的表达方式；下界 0 = 尾保护关闭（与 tailProtectTurns: 0 同义）。
    tailProtectMaxRecords: clampInteger(
      input?.tailProtectMaxRecords,
      defaults.tailProtectMaxRecords,
      0,
      1_000_000
    ),
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
    eviction: {
      // 密度阈值是小数保真的（0.5 与 1 是两条不同的选段策略），轮距是整数。
      lowAnchorDensityPerKiloChar: clampNumber(
        input?.eviction?.lowAnchorDensityPerKiloChar,
        defaults.eviction.lowAnchorDensityPerKiloChar,
        0,
        1_000
      ),
      staleRefetchableTurnDistance: clampInteger(
        input?.eviction?.staleRefetchableTurnDistance,
        defaults.eviction.staleRefetchableTurnDistance,
        0,
        1_000
      ),
      staleRefetchableRecordDistance: clampInteger(
        input?.eviction?.staleRefetchableRecordDistance,
        defaults.eviction.staleRefetchableRecordDistance,
        0,
        100_000
      ),
      payloadBackedTurnDistance: clampInteger(
        input?.eviction?.payloadBackedTurnDistance,
        defaults.eviction.payloadBackedTurnDistance,
        0,
        10_000
      ),
      payloadBackedRecordDistance: clampInteger(
        input?.eviction?.payloadBackedRecordDistance,
        defaults.eviction.payloadBackedRecordDistance,
        0,
        100_000
      ),
    },
    faultRecovery: {
      baseWarmLeaseTurns,
      maxWarmLeaseTurns,
      stickyAfterFaults: clampInteger(
        input?.faultRecovery?.stickyAfterFaults,
        defaults.faultRecovery.stickyAfterFaults,
        1,
        100
      ),
    },
    handoff: {
      // streak 至少 1：连续 0 次低收益就布防 = 一开机就劝人换会话。
      lowSavingStreak: clampInteger(
        input?.handoff?.lowSavingStreak,
        defaults.handoff.lowSavingStreak,
        1,
        100
      ),
      // 占用闸允许配到 0（= 只看收益，不看占用），所以不走 clampPercent 的 ≥1 下界。
      occupancyPercent: clampNumber(
        input?.handoff?.occupancyPercent,
        defaults.handoff.occupancyPercent,
        0,
        100
      ),
    },
    distillation: resolveDistillationConfig(input?.distillation),
    dashboard: input?.dashboard ?? defaults.dashboard,
  }
}

/** 预设 → 完整配置（预设只覆盖器械档，其余走默认）。 */
export function resolveContextGovernancePreset(
  name: ContextGovernancePresetName
): ContextGovernanceConfig {
  return resolveContextGovernanceConfig(ContextGovernancePresets[name])
}

/**
 * 蒸馏护栏的宽容解析。
 *
 * 两条语义不变量在这里兜住，而不是靠调用方自觉：
 *  - `targetChars` 必须严格小于 `maxInputChars`——目标比输入还大，产物永远过不了"不比原段落短"
 *    那道验证，等于配置一手把 I2 关死；
 *  - `minSegmentChars` 不得超过 `maxInputChars`——否则永远选不出段。
 */
function resolveDistillationConfig(
  input: ContextGovernanceConfigInput['distillation']
): ContextDistillConfig {
  const defaults = DefaultContextGovernanceConfig.distillation
  const maxInputChars = clampInteger(input?.maxInputChars, defaults.maxInputChars, 1_000, 1_000_000)
  const targetChars = Math.min(
    clampInteger(input?.targetChars, defaults.targetChars, 200, 100_000),
    Math.max(200, Math.floor(maxInputChars / 2))
  )

  return {
    maxResidentSummaries: clampInteger(
      input?.maxResidentSummaries,
      defaults.maxResidentSummaries,
      1,
      100
    ),
    maxSegmentsPerEpoch: clampInteger(input?.maxSegmentsPerEpoch, defaults.maxSegmentsPerEpoch, 1, 8),
    maxInputChars,
    targetChars,
    timeoutMs: clampInteger(input?.timeoutMs, defaults.timeoutMs, 100, 600_000),
    maxRequiredAnchors: clampInteger(input?.maxRequiredAnchors, defaults.maxRequiredAnchors, 0, 200),
    minSegmentChars: Math.min(
      clampInteger(input?.minSegmentChars, defaults.minSegmentChars, 0, 1_000_000),
      maxInputChars
    ),
    adaptive: {
      minShortfallPercent: clampNumber(
        input?.adaptive?.minShortfallPercent,
        defaults.adaptive.minShortfallPercent,
        0,
        100
      ),
      minNarrativeChars: clampInteger(
        input?.adaptive?.minNarrativeChars,
        defaults.adaptive.minNarrativeChars,
        0,
        1_000_000
      ),
      maxAnchorDensityPerKiloChar: clampNumber(
        input?.adaptive?.maxAnchorDensityPerKiloChar,
        defaults.adaptive.maxAnchorDensityPerKiloChar,
        0,
        1_000
      ),
      minSavingToCostRatio: clampNumber(
        input?.adaptive?.minSavingToCostRatio,
        defaults.adaptive.minSavingToCostRatio,
        0,
        1_000
      ),
      amortizationRequests: clampInteger(
        input?.adaptive?.amortizationRequests,
        defaults.adaptive.amortizationRequests,
        1,
        1_000
      ),
    },
  }
}

/**
 * 把外部传来的蒸馏档位字符串归一成合法档（去空白 + 转小写后与 `off / aux / main / adaptive` 精确比对）。
 * 认不出的一律回落默认档（当前是 `'aux'`）而**不报错**：一个手滑的档位名不该把整条治理链路打死——
 * 宿主没注入蒸馏器时它本来就会自动退化成纯机械（`skipReason: 'no-distiller'`），所以回落开档对无模型环境也是安全的。
 */
function resolveDistillInstrument(value: LooseOptional<string>): ContextDistillInstrument {
  const normalized = value?.trim().toLowerCase()
  const matched = DistillInstruments.find((instrument) => instrument === normalized)
  return matched ?? DefaultContextGovernanceConfig.instruments.distill
}

/**
 * 整数旋钮的宽容钳制：缺席或非有限数（undefined / null / NaN / Infinity）取 `fallback`，
 * 其余先向下取整再夹进 `[min, max]`。**钳制不拒绝**——越界值夹到合法区间继续可用，不为一个手滑的配置抛错把治理链路打死。
 * 向下取整只用于真正的整数量纲（轮距、字符数、次数）；比率类阈值必须走 `clampNumber` 保小数。
 */
function clampInteger(
  value: LooseOptional<number>,
  fallback: number,
  min: number,
  max: number
): number {
  if (!isPresent(value) || !isFiniteNumber(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** 小数保真的钳制（比率类阈值不能取整——1.5 取整成 1 就换了一个策略）。 */
function clampNumber(
  value: LooseOptional<number>,
  fallback: number,
  min: number,
  max: number
): number {
  if (!isPresent(value) || !isFiniteNumber(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 百分比旋钮的钳制：整数化后夹进 `[1, 100]`，缺席取 `fallback`。
 * 下界是 1 而不是 0——水位类百分比取 0 会让 epoch 一开机就恒定触发/恒定达标，等于把那道闸拧死。
 * 真正允许配到 0 的百分比（如 `handoff.occupancyPercent`，0 = 只看收益不看占用）必须绕开本函数走 `clampNumber`。
 */
function clampPercent(value: LooseOptional<number>, fallback: number): number {
  return clampInteger(value, fallback, 1, 100)
}
