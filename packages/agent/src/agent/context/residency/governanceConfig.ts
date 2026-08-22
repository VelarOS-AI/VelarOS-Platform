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

/**
 * I2 蒸馏档位 —— 论文 RQ3 的三条实验臂，同一条代码路径，差异只在"什么时刻肯花这一跳"。
 *
 *  - `off`：从不花（A0/A1 臂，纯机械）。
 *  - `aux`（默认）/ `main`：**机械器械没达标就花**（A2-distill-always），差别只是宿主拿辅助模型
 *    还是主模型去跑。
 *  - `adaptive`：在 `aux` 的前提上再过三道判据——缺口够大 / 段落价值密度够高 / 预计节省 ≥ 调用
 *    成本的若干倍（A3，论文主臂，阈值见 {@link ContextDistillAdaptiveConfig}）。
 *
 * 四档都不会在"机械器械已经达标"时花这一跳：那时候段落根本不必折，蒸馏就没有对照物。
 */
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

/**
 * adaptive 档的三道判据（论文 RQ3 的机制本体）。
 *
 * 三个阈值一个都不写死在逻辑里：它们**就是**"什么时刻值得一次 LLM 调用"这个研究问题的自由度，
 * 写死等于把结论钉在代码里再去测它。全部列为 B4 扫参对象。
 */
export interface ContextDistillAdaptiveConfig {
  /** ① 机械器械（I0+I1）跑完后距目标水位至少还差这么多百分点（占 G），才认为骨架不足以达标。 */
  minShortfallPercent: number
  /** ② 段落价值密度：叙事字符量下限——太短的段落省不出调用成本。 */
  minNarrativeChars: number
  /**
   * ② 段落价值密度：锚点密度上限（每千字符）。
   *
   * 锚点密集的段落规则骨架已经抽得很好，LLM 加不了多少值。**默认值刻意高于 I0 的
   * {@link ContextEvictionConfig.lowAnchorDensityPerKiloChar}（2）**：I2 规划发生在 I0 之后，
   * 密度低于 2 的叙事早被 I0 逐出并折进骨架了，能活到 I2 面前的段落密度必然 ≥ 2。两条阈值取同一
   * 个数，等于把 I2 永久关死——B4 扫参同时动这两个旋钮时，这条关系必须一起维持。
   */
  maxAnchorDensityPerKiloChar: number
  /**
   * ③ 预计（摊销后）节省 token / 预计调用成本 token 的最小倍数。
   *
   * 节省是**每次请求都省**的经常性收益，调用成本是**一次性**支出，两者不同量纲，直接比是错的。
   * 所以先按 {@link amortizationRequests} 把节省摊到若干次请求上，再和成本比。
   */
  minSavingToCostRatio: number
  /**
   * ③ 摊销窗口：预计到下一个 epoch 之前还要发多少次请求。
   *
   * 这是"这次蒸馏能省几遍"的估计值——设成 1 就是要求一次调用当场回本（几乎不可能：输入里本来
   * 就装着整个段落），设得过大则任何段落都值得蒸。B4 扫参对象。
   */
  amortizationRequests: number
}

/** I2 蒸馏的成本护栏与产物规格（档位之外的全部旋钮）。 */
export interface ContextDistillConfig {
  /** prompt 中同时保留的最近摘要数；更老摘要转为隐藏冷记录，原始成员仍可精确检索。 */
  maxResidentSummaries: number
  /** 每个 epoch 最多规划几段蒸馏（并发仍恒为 1，多出来的排队）。 */
  maxSegmentsPerEpoch: number
  /** 单次蒸馏的输入字符上限（沿用 v1 `MaxSummarizerInputChars` 的 48K）。 */
  maxInputChars: number
  /** 产物正文的目标字符数。 */
  targetChars: number
  /** 单次蒸馏超时（毫秒），到点回落 I1 骨架。 */
  timeoutMs: number
  /** 必须逐字保留的锚点条数上限（提示词里明示，产物按此逐条验证）。 */
  maxRequiredAnchors: number
  /** 段落进入蒸馏的最小字符数。 */
  minSegmentChars: number
  adaptive: ContextDistillAdaptiveConfig
}

/**
 * I0 机械逐出的选段阈值（B3 起进配置面，B4 扫参对象）。
 *
 * 这两个数原先是 `GovernanceEpoch.ts` 里的模块常量。搬进来的理由不是"配置越多越好"，而是
 * **它们决定了 I0 从账本里挑走哪些记录**——离线重放要拿同一本账本跑不同的选段策略，写死在
 * 代码里的阈值等于把这一维实验钉死。默认值逐字沿用原常量，行为零变化。
 */
export interface ContextEvictionConfig {
  /**
   * 低锚密度阈值（每千字符锚点数）。低于此值的段落信息密度不足以占住全文位。
   *
   * 与 {@link ContextDistillAdaptiveConfig.maxAnchorDensityPerKiloChar}（默认 6）共同划出 I2
   * 吃的那条带：`(本值, 6]`。把本值调到 ≥ 6 等于让 I0 先把 I2 的口粮全吃掉。
   */
  lowAnchorDensityPerKiloChar: number
  /** 认定"陈旧"的最小轮距：可重取记录至少落后当前轮这么多轮才进 I0 候选。 */
  staleRefetchableTurnDistance: number
  /** 单个用户轮内长自主执行时的记录距离兜底；避免只按 user turn 计算导致永不陈旧。 */
  staleRefetchableRecordDistance: number
  /**
   * 已有内容寻址 payload 的工具结果进入冷驻留候选前至少等待的轮距。
   *
   * 这条路不重新执行工具，只把 prompt 正文换成精确 payload 引用；因此它比“可重取”更可靠，
   * 但仍要给当前任务留出足够的直接使用窗口。
   */
  payloadBackedTurnDistance: number
  /** payload-backed 记录在单轮长执行中的最小记录距离。 */
  payloadBackedRecordDistance: number
}

/** 缺页后的升温与防抖策略。 */
export interface ContextFaultRecoveryConfig {
  /** 第一次缺页后保持重新驻留的轮数。后续缺页按 2 的幂次延长。 */
  baseWarmLeaseTurns: number
  /** 单次升温租约上限。 */
  maxWarmLeaseTurns: number
  /** 同一记录累计缺页达到该次数后，在当前账本代内保持驻留。 */
  stickyAfterFaults: number
}

/**
 * 转交（handoff）布防阈值（B3 起进配置面，B4 扫参对象）。
 *
 * 这两个数原先是 `ContextGovernanceSession.ts` 里的模块常量，与 `ContextEvictionConfig` 同一处境：
 * 设计 §4 明写 35% 那道占用闸"留作扫参对象"，写死在代码里等于每扫一次参就要改代码重编译。
 * 默认值逐字沿用原常量，行为零变化。
 */
export interface ContextHandoffConfig {
  /** 连续多少次低收益 epoch 才认为"压不下去了"。 */
  lowSavingStreak: number
  /** post-epoch 占用高于该百分比（占 G）才布防转交。 */
  occupancyPercent: number
}

export interface ContextGovernanceConfig {
  /**
   * 治理窗口 **上限**：`G = min(cap, 送核门余量)`（推导见 `governanceWindow.ts`）。
   *
   * 语义从 v3 的「min(模型窗口, cap)」收窄成纯上限：分母改由送核门余量定，cap 只负责
   * 把超大窗口（1M）下的 G 锁回可治理的量级。
   */
  cap: number
  /** 尾保护轮数：最近若干轮对话恒以全文投影。 */
  tailProtectTurns: number
  /**
   * 尾保护条数：最近若干**条记录**。与 {@link tailProtectTurns} 取**交集**（两条都满足才受保护）。
   *
   * 存在理由是量纲：轮数量的是"模型正在聊哪件事"，而压力来自"这一轮里已经堆了多少条工具痕迹"。
   * 一次长自主运行（用户发一条指令、agent 连跑几十轮工具）整本账本只有 1 个对话轮，光按轮算
   * 会让每条记录都落在窗口内、治理器一条候选都收不到——本子系统在它最该发挥作用的形态下 100%
   * 空转（审计 V1）。
   *
   * 默认 16：普通对话一轮约 4-6 条记录，两轮 8-12 条，条数闸基本不咬合（尾保护仍等于轮窗口）；
   * 而在长自主运行里它把保护收敛到最近约 8 个工具步——模型手边真正在用的那一截。
   * 0 = 尾保护关闭（与 `tailProtectTurns: 0` 同义）。
   */
  tailProtectMaxRecords: number
  /** epoch 触发水位（占 G 的百分比）。 */
  epochTriggerPercent: number
  /** epoch 目标水位（占 G 的百分比）。 */
  epochTargetPercent: number
  /** 反空转：预计节省低于该百分比则跳过本次 epoch。 */
  minEpochSavingPercent: number
  admission: ContextAdmissionConfig
  instruments: ContextInstrumentConfig
  /** I0 机械逐出的选段阈值。 */
  eviction: ContextEvictionConfig
  /** 召回缺页后的升温、防抖与粘滞保护。 */
  faultRecovery: ContextFaultRecoveryConfig
  /** 转交布防阈值。 */
  handoff: ContextHandoffConfig
  /** I2 蒸馏的成本护栏与 adaptive 判据（档位在 `instruments.distill`）。 */
  distillation: ContextDistillConfig
  /** 活动尾的 context-dashboard 块（模型本体感知）。 */
  dashboard: boolean
}

export const DefaultContextGovernanceConfig: ContextGovernanceConfig = {
  cap: 200_000,
  tailProtectTurns: 2,
  tailProtectMaxRecords: 16,
  epochTriggerPercent: 70,
  epochTargetPercent: 40,
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
} as const satisfies Record<string, ContextGovernanceConfigInput>

export type ContextGovernancePresetName = keyof typeof ContextGovernancePresets

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

export interface ContextGovernanceConfigInput {
  cap?: LooseOptional<number>
  tailProtectTurns?: LooseOptional<number>
  tailProtectMaxRecords?: LooseOptional<number>
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
  eviction?: LooseOptional<{
    lowAnchorDensityPerKiloChar?: LooseOptional<number>
    staleRefetchableTurnDistance?: LooseOptional<number>
    staleRefetchableRecordDistance?: LooseOptional<number>
    payloadBackedTurnDistance?: LooseOptional<number>
    payloadBackedRecordDistance?: LooseOptional<number>
  }>
  faultRecovery?: LooseOptional<{
    baseWarmLeaseTurns?: LooseOptional<number>
    maxWarmLeaseTurns?: LooseOptional<number>
    stickyAfterFaults?: LooseOptional<number>
  }>
  handoff?: LooseOptional<{
    lowSavingStreak?: LooseOptional<number>
    occupancyPercent?: LooseOptional<number>
  }>
  distillation?: LooseOptional<{
    maxResidentSummaries?: LooseOptional<number>
    maxSegmentsPerEpoch?: LooseOptional<number>
    maxInputChars?: LooseOptional<number>
    targetChars?: LooseOptional<number>
    timeoutMs?: LooseOptional<number>
    maxRequiredAnchors?: LooseOptional<number>
    minSegmentChars?: LooseOptional<number>
    adaptive?: LooseOptional<{
      minShortfallPercent?: LooseOptional<number>
      minNarrativeChars?: LooseOptional<number>
      maxAnchorDensityPerKiloChar?: LooseOptional<number>
      minSavingToCostRatio?: LooseOptional<number>
      amortizationRequests?: LooseOptional<number>
    }>
  }>
  dashboard?: LooseOptional<boolean>
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

function clampPercent(value: LooseOptional<number>, fallback: number): number {
  return clampInteger(value, fallback, 1, 100)
}
