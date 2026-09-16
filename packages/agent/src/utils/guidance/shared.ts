import { isEmpty } from '@velaros-ai/core'

import type { PromptCompositionResult,PromptSegmentDefinition, PromptSegmentRetention, PromptSegmentSource, PromptSegmentStability, PromptSegmentTier, RuntimePromptSnapshot } from '../../types/guidance.js'

/**
 * 段优先级带（按行为知识三层分带；层序由注册表保证，带内数值只决定同层内部顺序与裁剪判据）。
 *
 * Tier0（core，0–99）：内置身份与品牌语气；宿主自有不可变纪律可使用预留的安全边界位。
 * Tier1（runtime，1_000–8_999）：运行态指导。`capabilityProtocol` 是用户显式开启的能力协议段；
 *   `runtimeAdvice` 是执行模式/计划一类本轮建议。
 * Tier2（skill，9_000）：技能索引与命中指针。
 *
 * 2026-08-06 删除的死常量（全树零消费者）：`developmentP0` / `role` / `strategy` / `guardrail`，
 * 以及 `datetime: 500`——真实的 datetime 段自带字面量 9_020，从来没读过这个常量。
 */
export const PromptSegmentPriority = {
  identity: 0,
  brandVoice: 10,
  // 对外兼容的通用纪律优先级；内置 Tier0 保持身份与品牌语气两段。
  safetyBoundary: 20,
  runtime: 1_000,
  capabilityProtocol: 1_200,
  runtimeAdvice: 1_500,
  skill: 9_000,
  user: 10_000,
} as const

/**
 * 把一串标签拼成提示词里的一行（顿号分隔）；空清单渲染成 `无` 而不是空串。
 * 给"无"这个明确说法是有意的：提示词里出现一个空着的字段，模型会当成信息缺失去猜，而这里的事实恰恰是"确实一个都没有"。
 */
export function formatLabelList(labels: string[]): string {
  return !isEmpty(labels) ? labels.join('、') : '无'
}

/**
 * 把运行快照里各能力类别下的工具名摊平成一个集合，供提示词段判断"这个工具这轮在不在"。
 * **不看类别的 `enabled`**：只要工具登记在类别里就算数，判"是否启用"要另走 {@link hasAnyRuntimeToolAvailable}。
 * 每次调用现建一个 Set，不缓存——快照逐轮变化，缓存反而会让某一轮按上一轮的工具面渲染。
 */
export function getRuntimeToolNames(snapshot: RuntimePromptSnapshot): Set<string> {
  return new Set(
    snapshot.toolCapabilityCategories.flatMap((category) =>
      category.tools.map((tool) => tool.name)
    )
  )
}

/**
 * 判这一轮的工具面里有没有登记某个工具名（逐字比对，不认别名）。
 * 提示词段用它做 `when` 谓词：讲某个工具怎么用的段落，在那个工具不在的轮次里就整段不渲染，免得教模型调一个它根本调不到的工具。
 */
export function hasRuntimeTool(snapshot: RuntimePromptSnapshot, toolName: string): boolean {
  return getRuntimeToolNames(snapshot).has(toolName)
}

/**
 * 判给定的这批工具名里**至少有一个**登记在这一轮的工具面里（OR 语义，不是全都要有）。
 * 用于一段提示词覆盖同一组能力的多个工具：只要其中一个可用，这段话就仍然有意义，不该整段消失。
 * 传空清单返回 false。
 */
export function hasAnyRuntimeTool(
  snapshot: RuntimePromptSnapshot,
  toolNames: string[]
): boolean {
  const available = getRuntimeToolNames(snapshot)
  return toolNames.some((toolName) => available.has(toolName))
}

/**
 * 判这一轮**究竟有没有工具可用**：存在至少一个 `enabled` 且工具非空的能力类别。
 * 与 {@link getRuntimeToolNames} 那条路不同，这里要看 `enabled`——一个类别登记了工具却被关停，
 * 对模型来说等于没有。整条为假时（纯聊天轮、工具全被作用域挡掉），讲工具用法的段落应当整体不渲染。
 */
export function hasAnyRuntimeToolAvailable(snapshot: RuntimePromptSnapshot): boolean {
  return snapshot.toolCapabilityCategories.some(
    (category) => category.enabled && !isEmpty(category.tools)
  )
}

/**
 * Tier0 段工厂（唯一入口）。
 *
 * **刻意不接受 `when` 谓词、也拿不到 `PromptRenderContext`**：Tier0 的契约是「稳定前缀逐字不变」，
 * 一旦允许按 facts 判定，前缀就会随会话状态分叉，而分叉的代价（整段历史掉出 provider 前缀缓存）
 * 是静默且以 token 计的。要按运行态开关的内容一律是 Tier1。
 */
export function createCorePromptSegment(args: {
  id: string
  label: string
  source: PromptSegmentSource
  priority: number
  text: string
}): PromptSegmentDefinition {
  return {
    id: args.id,
    label: args.label,
    tier: 'core',
    source: args.source,
    priority: args.priority,
    render: () => args.text,
  }
}

/**
 * Tier1 / Tier2 纯文本段的通用工厂：把 id、标签、层、来源、优先级、保留级与一段固定文本包成段定义。
 * `tier` 缺省 `'runtime'`，**签名上就排除了 `'core'`**——Tier0 必须走 {@link createCorePromptSegment}，
 * 因为只有它保证"稳定前缀逐字不变"（这里允许传 `when`，一旦用在 Tier0 上前缀就会随会话状态分叉，代价是整段历史掉出前缀缓存）。
 * `text` 可为 null：渲染出空内容的段会被组装器按"渲染为空"关停并留痕，不会在提示词里留下一个空壳标题。
 */
export function createTextPromptSegment(args: {
  id: string
  label: string
  /** 行为知识层；缺省 Tier1。Tier0 走 {@link createCorePromptSegment}，此处不接受 `core`。 */
  tier?: Exclude<PromptSegmentTier, 'core'>
  source: PromptSegmentSource
  priority: number
  retention?: PromptSegmentRetention
  text: Nullable<string>
  when?: () => boolean
}): PromptSegmentDefinition {
  return {
    id: args.id,
    label: args.label,
    tier: args.tier ?? 'runtime',
    source: args.source,
    priority: args.priority,
    retention: args.retention,
    when: args.when,
    render: () => args.text,
  }
}

/**
 * Tier2 技能段（角色技能全文档位）。
 *
 * 技能索引承载用户显式选择，`retention: 'protected'` 保证该意图跨预算裁剪保留。
 */
export function createSkillPromptSegment(id: string, text: string): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: `skill.${id}`,
    label: 'Role Skill',
    tier: 'skill',
    retention: 'protected',
    source: 'skill',
    priority: PromptSegmentPriority.skill,
    text,
  })
}

/**
 * 某段没进这一轮提示词时的留痕条目。
 *
 * 「被拦下」与「不存在」在调试面板上长得一模一样，reason 是唯一能区分二者的东西，所以四条关停
 * 通道（压制 / 配置关停 / 谓词不满足 / 渲染为空）都要落一条。稳定性由调用方按段的层先算好再传进来。
 */
export function createSkippedPromptSegment(
  definition: PromptSegmentDefinition,
  reason: string,
  stability: PromptSegmentStability
): PromptCompositionResult['skipped'][number] {
  return {
    id: definition.id,
    label: definition.label,
    stability,
    source: definition.source,
    priority: definition.priority,
    reason,
  }
}

/** Tier2 技能段（主 Agent 本轮命中/选中的技能指针）。 */
export function createSelectedSkillPromptSegment(text: string): PromptSegmentDefinition {
  return createTextPromptSegment({
    id: 'skill.active',
    label: 'Active Skills',
    tier: 'skill',
    retention: 'protected',
    source: 'skill',
    priority: PromptSegmentPriority.skill,
    text,
  })
}
