// 执行模式注册表：两个官方模式的预制 descriptor + 模式轴归一/兼容折算。
//
// 预制 descriptor 把此前散在提示词构建与会话粘性两处的硬编码事实（提示词特性 id、
// 快照标志名、粘性语义）**重表达为声明**，消费点改经本注册表解析单源。
// 新模式 = 纯声明零改码（构造一份 descriptor 即可）。
//
// ## 为什么模式要有自己的轴（2026-08-06 拆轴）
// 拆轴前，「执行模式」和「插件能力启用」共用 `promptFeatures` 一根 `string[]`：
// plan 是数组里的一个 id，goal 是旁边一个布尔——同一个概念两种形态，且与能力混在一起。
// 后果不是审美问题：
//  - 「hook send 省略 promptFeatures」的回落语义对能力（缺席=不开）与模式（缺席=回落会话粘性）
//    本就不同，挤在一根轴上只能二选一，于是出现过模式被漏传后静默消失的 footgun；
//  - 能力面归一（按宿主目录剥除未登记 id）会顺手把模式 id 一起判成「未登记」；
//  - 「模式选中了吗」在全树散成 `promptFeatures.includes('plan')` 与 `isTrue(goalMode)` 两种写法。
//
// 拆轴后：`executionModes: ExecutionModeId[]` 是权威源，`promptFeatures` 只留能力。
// 旧形态不做破坏性迁移——{@link resolveExecutionModes} 在读取侧折算，因此存量会话与旧宿主
// 请求路径（定时任务、无人值守、外部引擎）一个都不用改就继续成立。
import type { ChatPromptFeatureId, ExecutionModeId } from '@velaros-ai/agent/protocol'
import { isNotNull, isString, isTrue, toNullable } from '@velaros-ai/core'

import type { ExecutionModeDescriptor } from './ExecutionModeDescriptor'

/**
 * 目标模式（goal）。
 *
 * 拆轴前没有提示词特性——走 `AgentExecutionConfig.goalMode` 布尔 / 活跃目标推断（见 PromptState 的
 * `goalMode: isTrue(goalMode) || hasActiveGoal`）。工具面另有 `GoalModeRequiredToolNames`
 * （goal:get/goal:create/goal:update）保护集，属 SoloRunPlanPreparer 曝光深水域。
 */
const goalModeDescriptor: ExecutionModeDescriptor = {
  id: 'goal',
  label: '目标模式',
  prompt: { snapshotFlag: 'goalMode', legacyPromptFeatureId: null },
  stickiness: { sessionSticky: false },
}

/**
 * 计划模式（plan）。
 *
 * 提示词面由 `userRequestedPlan` 快照标志驱动；工具面**不限制执行**，只把计划工具保护进
 * 本轮曝光集。会话级粘滞。
 */
const planModeDescriptor: ExecutionModeDescriptor = {
  id: 'plan',
  label: '计划模式',
  prompt: { snapshotFlag: 'userRequestedPlan', legacyPromptFeatureId: 'plan' },
  stickiness: { sessionSticky: true },
}

/** 官方预制模式注册表（封闭轴集合，新增预制在此追加；用户/harness 亦可零改码构造新 descriptor）。 */
const ExecutionModeRegistry: Readonly<Record<ExecutionModeId, ExecutionModeDescriptor>> = {
  goal: goalModeDescriptor,
  plan: planModeDescriptor,
}

/** 归一化时的稳定顺序（= 注册表声明序）：同一集合恒得同一数组，顺序抖动不会进任何指纹。 */
const ExecutionModeOrder: readonly ExecutionModeId[] = ['goal', 'plan']

/** 按 id 解析预制执行模式描述符。 */
function getExecutionMode(id: ExecutionModeId): ExecutionModeDescriptor {
  return ExecutionModeRegistry[id]
}

/** 列出全部预制执行模式描述符。 */
function listExecutionModes(): readonly ExecutionModeDescriptor[] {
  return [goalModeDescriptor, planModeDescriptor]
}

/** 由**旧形态**提示词特性反查其激活的执行模式（goal 无特性，永不命中）。 */
function resolveExecutionModeForPromptFeature(
  feature: ChatPromptFeatureId
): Nullable<ExecutionModeDescriptor> {
  return toNullable(
    listExecutionModes().find(
      (descriptor) => descriptor.prompt.legacyPromptFeatureId === feature
    )
  )
}

/** 模式 id 判定（轴是封闭集，注册表即全集）。 */
function isExecutionModeId(value: unknown): value is ExecutionModeId {
  return isString(value) && value in ExecutionModeRegistry
}

/**
 * 模式轴归一：丢弃未知 id、去重、按注册表声明序排。
 *
 * 未知 id **静默丢弃**而不是抛错：轴是封闭集，磁盘/线上出现未知值只可能来自跨版本升降级，
 * 为此锁死一次会话加载不划算（与 `resolveStoredPromptFeatures` 同一条宽容口径）。
 */
function normalizeExecutionModes(values: readonly unknown[] = []): ExecutionModeId[] {
  const selected = new Set(values.filter(isExecutionModeId))
  return ExecutionModeOrder.filter((id) => selected.has(id))
}

/**
 * 执行模式解析单源——**每个读取点都必须经过这里**，不许自己 `includes('plan')`。
 *
 * 折算顺序（并集，不是覆盖）：
 *  1. 新轴 `executionModes`（权威）；
 *  2. 旧形态 `promptFeatures` 里的模式特性 id（plan）；
 *  3. 旧形态 `goalMode` 布尔。
 *
 * 取并集而不是「新轴存在就忽略旧的」：拆轴期两种形态会在同一条链路上共存（renderer 已写新轴、
 * 某个中间层还在透传旧 goalMode），覆盖语义会让其中一半静默消失；而两种形态一致时并集与
 * 任一单独形态**逐字相同**（幂等）。
 */
function resolveExecutionModes(source: {
  executionModes?: LooseOptional<readonly unknown[]>
  promptFeatures?: LooseOptional<readonly ChatPromptFeatureId[]>
  goalMode?: unknown
}): ExecutionModeId[] {
  const modes = new Set<ExecutionModeId>(normalizeExecutionModes(source.executionModes ?? []))
  for (const feature of source.promptFeatures ?? []) {
    const descriptor = resolveExecutionModeForPromptFeature(feature)
    if (descriptor) modes.add(descriptor.id)
  }
  if (isTrue(source.goalMode)) modes.add('goal')
  return ExecutionModeOrder.filter((id) => modes.has(id))
}

/**
 * 从能力轴剥除执行模式的旧形态 id。
 *
 * 模式已有自己的轴，留在 `promptFeatures` 里会让能力面（输入区菜单、feature→工具分类映射、
 * 「本轮已选能力」提示词段）把一个执行模式当成插件能力展示。
 */
function stripExecutionModePromptFeatures(
  features: readonly ChatPromptFeatureId[] = []
): ChatPromptFeatureId[] {
  const legacyIds = new Set(
    listExecutionModes()
      .map((descriptor) => descriptor.prompt.legacyPromptFeatureId)
      .filter(isNotNull)
  )
  return features.filter((feature) => !legacyIds.has(feature))
}

/** 判定某执行模式是否在本轮模式轴里（读取点唯一谓词）。 */
function isExecutionModeActive(
  id: ExecutionModeId,
  modes: readonly ExecutionModeId[] = []
): boolean {
  return modes.includes(id)
}

export {
  ExecutionModeOrder,
  ExecutionModeRegistry,
  getExecutionMode,
  isExecutionModeActive,
  isExecutionModeId,
  listExecutionModes,
  normalizeExecutionModes,
  resolveExecutionModeForPromptFeature,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
}
