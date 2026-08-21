// 域：system prompt 的**段注册表与组合器**——决定「哪些段进这一轮的提示词、以什么顺序、算不算稳定」。
//
// ## ① 段序即字节序（算法不变量）
// 组合结果直接决定 system prompt 的字节。排序键是 `(tierRank, priority, id)`，其中 id 的比较**必须**走
// `compareStableStrings`（码元序）而不是 locale 相关比较——否则同一份配置在不同机器上生成不同字节的
// 提示词，前缀缓存跨机器全失效，且表现为「有的机器贵有的机器便宜」，没人会想到是排序。
// 同 priority 靠 id 兜底而不是靠注册顺序，是为了让「换个装配顺序」不改变输出。
//
// ## ② 行为知识三层（Tier）是**结构**，stable/dynamic 由它派生
// 段不再自报 `stability`，只声明自己属于哪一层；`stability` 由 {@link resolvePromptSegmentStability}
// 机械派生，因此「把一个逐轮变化的段标成 stable」这件事在类型层就不再可表达：
//  - `core`（Tier0 身份/安全/不可变纪律）→ `stable`，进稳定前缀，**逐字不变**。
//    Tier0 段只能由 `createCorePromptSegment` 构造——它不接受 `when` 谓词、不读 facts，
//    渲染结果是构造期就固定的常量，前缀因此结构上不可能逐轮分叉。
//  - `runtime`（Tier1 运行态段：空间/模式/工具面）→ `dynamic`，进活动尾。
//  - `skill`（Tier2 技能，工艺知识唯一的家）→ `dynamic`，进活动尾（选中集逐轮可变）。
// 历史病灶：能力协议段（HTML 实时预览/Widget）与技能索引段曾声明 `stable`，但它们的 `when`
// 读的是**逐轮重算**的 facts（最新一条 user 消息的正则命中、本轮选中技能集、bootstrap/operational
// 阶段），于是稳定前缀每隔一轮就分叉一次——前缀缓存连同它后面的整段历史一起失效。
//
// ## ③ 跳过一定要留痕（§2.6）
// 被 suppress / 被配置关停 / 谓词不满足 / 渲染为空，四种情况都进 `skipped` 并带 reason。
// 「某段没进提示词」与「某段不存在」在调试时长得完全一样，reason 是唯一能区分二者的东西。
//
// ## ④ 三条关停通道的优先级是固定的
// `suppressions`（运行时临时）> `overrides`（持久化配置）> `when`（谓词）。运行时压制必须能盖过用户
// 配置，否则「本轮临时关掉某段」这个动作会被持久配置悄悄推翻。
//
// ## ⑤ `clone()` 的存在理由
// ContextBuilder 会派生变体（子 Agent / 不同 surface）；共享同一注册表会让一次 `suppress` 泄漏到别的
// 变体上。clone 复制定义与压制态、共享 provider 引用（provider 是无状态加载器）。
//
import type { PromptSegmentOverride } from '@velaros-ai/agent/protocol'
import { AppError } from '@velaros-ai/core/error'

import { compareStableStrings } from '../agent/context/residency/determinism'
import type { AgentChatRuntimeConfig } from '../agent/RuntimeConfiguration'
/** Prompt 段稳定性：stable 适合缓存，dynamic 每轮可能变化。由 tier 派生，不再由段自报。 */
type PromptSegmentStability = 'stable' | 'dynamic'
/**
 * 行为知识三层。
 *
 * - `core`：Tier0，身份 / 安全 / 不可变纪律。进稳定前缀，逐字不变，极小。
 * - `runtime`：Tier1，按会话状态装配的运行态指导（空间、执行模式、工具面、能力协议）。
 * - `skill`：Tier2，工艺知识（怎么做好某类任务）。descriptor 常驻、选中才注入全文。
 */
type PromptSegmentTier = 'core' | 'runtime' | 'skill'

/** 层序即块序：Tier0 在稳定前缀，Tier1/Tier2 在活动尾且 Tier2 恒排 Tier1 之后。 */
const PromptSegmentTierRank: Readonly<Record<PromptSegmentTier, number>> = {
  core: 0,
  runtime: 1,
  skill: 2,
}

/** 稳定性由层派生：只有 Tier0 进稳定前缀。 */
function resolvePromptSegmentStability(tier: PromptSegmentTier): PromptSegmentStability {
  return tier === 'core' ? 'stable' : 'dynamic'
}

/**
 * Tier0 不许带激活谓词——注册面机械拦截，不靠「用 createCorePromptSegment 构造」这条约定。
 *
 * `createCorePromptSegment` 不暴露 `when` 只是把这件事做成了**工厂的**不变量：注册面收的是
 * 裸 `PromptSegmentDefinition`，`{ tier: 'core', when }` 在类型上完全可表达，任何绕过工厂的
 * 注册（宿主自己拼一份、mod 投影、provider 动态生成）都能把一个逐轮开关的段塞进稳定前缀。
 * 后果不是「多一段」而是**前缀缓存整体失效**——它后面的全部历史一起作废，且症状只表现为
 * 「有时候贵」，几乎没人会往提示词分层上想（§② 的历史病灶就是这么来的）。
 */
function assertCorePromptSegmentHasNoPredicate(definition: PromptSegmentDefinition): void {
  if (definition.tier === 'core' && definition.when) {
    throw new AppError(
      'VALIDATION',
      `Tier0 段「${definition.id}」不许带激活谓词：core 段进稳定前缀且必须逐轮字节不变，按 facts 开关的内容请落 tier:'runtime'。`
    )
  }
}
/**
 * 存量 `segmentOverrides` 的段 id 别名（旧 id → 现 id）。
 *
 * 段 id 是**持久化配置的主键**——用户关掉某段，磁盘上留下的就是这个字符串。所以改段 id 是
 * 破坏性变更：失配不会报错，只会让那段悄悄回到开启状态，用户以为已经关掉的内容又出现在
 * 提示词里，且没有任何线索指向「我改过 id」。改一次名就在这里补一行，别指望迁移脚本
 * （overrides 落在宿主的系统配置里，包这边够不着）。
 */
const PromptSegmentIdAliases: Readonly<Record<string, string | undefined>> = {}

/** protected 段属于上下文保护区，不允许被运行配置的 prompt 预算裁剪。 */
type PromptSegmentRetention = 'normal' | 'protected'
/** Prompt 段来源，用于调试面板解释每段从哪里来。 */
type PromptSegmentSource = string

interface PromptBudgetOptions {
  profile: string
  maxChars: number
}

interface PromptRenderContext {
  /** 聊天配置，主要读取用户追加 system prompt。 */
  chatConfig?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>
  /** 运行时事实，供 when/render 判断。 */
  facts?: Record<string, unknown>
  /** 持久化 prompt 段启停覆盖。 */
  overrides?: PromptSegmentOverride[]
}

interface PromptSegmentDefinition {
  /** 段 id，要求全局稳定唯一。 */
  id: string
  /** 人类可读标签。 */
  label?: string
  /** 行为知识层；stable/dynamic 由它派生，段不得自报稳定性。 */
  tier: PromptSegmentTier
  /** 段来源。 */
  source: PromptSegmentSource
  /** 排序优先级，越小越靠前。 */
  priority: number
  /** protected 表示该段必须逐轮保留，由独立生命周期负责控制容量。 */
  retention?: PromptSegmentRetention
  /** 可选标签，便于未来筛选。 */
  tags?: string[]
  /** 激活谓词，返回 false 时跳过该段。 */
  when?: (context: PromptRenderContext) => boolean
  /** 渲染段文本；空值会被跳过。 */
  render: (context: PromptRenderContext) => Nullable<string>
}

interface PromptSegmentProvider {
  /** provider id。 */
  id: string
  /** 根据当前渲染上下文动态加载段定义。 */
  load: (context: PromptRenderContext) => PromptSegmentDefinition[]
}

interface PromptContribution {
  id: string
  label?: string
  tier: PromptSegmentTier
  stability: PromptSegmentStability
  source: PromptSegmentSource
  priority: number
  retention: PromptSegmentRetention
  text: string
}

interface PromptSuppression {
  /** 跳过原因。 */
  reason: string
}

interface PromptCompositionResult {
  /** stable 段，最终放在 prompt 前半部分。 */
  stableParts: PromptContribution[]
  /** dynamic 段，最终放在 prompt 后半部分。 */
  dynamicParts: PromptContribution[]
  /** 被禁用、谓词不满足或渲染为空的段。 */
  skipped: Array<{
    id: string
    label?: string
    stability: PromptSegmentStability
    source: PromptSegmentSource
    priority: number
    reason: string
  }>
}

/**
 * Prompt 段注册表。
 *
 * ContextBuilder 使用它组合 system prompt：
 * - definitions 是静态注册段。
 * - providers 可按当前上下文动态生成段。
 * - suppressions/overrides 可以禁用某些段。
 */
class PromptRegistry {
  /** 静态 prompt 段定义。 */
  private readonly definitions = new Map<string, PromptSegmentDefinition>()
  /** 动态 prompt 段 provider。 */
  private readonly providers = new Map<string, PromptSegmentProvider>()
  /** 运行时禁用段。 */
  private readonly suppressions = new Map<string, PromptSuppression>()

  constructor(definitions: PromptSegmentDefinition[] = []) {
    this.registerMany(definitions)
  }

  /** 注册或覆盖单个 prompt 段（Tier0 带谓词即抛，见 {@link assertCorePromptSegmentHasNoPredicate}）。 */
  public register(definition: PromptSegmentDefinition): this {
    assertCorePromptSegmentHasNoPredicate(definition)
    this.definitions.set(definition.id, definition)
    return this
  }

  /** 批量注册 prompt 段。 */
  public registerMany(definitions: PromptSegmentDefinition[]): this {
    for (const definition of definitions) {
      this.register(definition)
    }
    return this
  }

  /** 注册动态段 provider。 */
  public registerProvider(provider: PromptSegmentProvider): this {
    this.providers.set(provider.id, provider)
    return this
  }

  /** 运行时禁用某个段。 */
  public suppress(id: string, reason: string): this {
    this.suppressions.set(id, { reason })
    return this
  }

  /** 恢复被 suppress 的段。 */
  public restore(id: string): this {
    this.suppressions.delete(id)
    return this
  }

  /** 组合所有可用段，并返回 stable/dynamic/skipped 分组结果。 */
  public compose(context: PromptRenderContext = {}): PromptCompositionResult {
    const contributions: PromptContribution[] = []
    const skipped: PromptCompositionResult['skipped'] = []
    const overrides = new Map<string, PromptSegmentOverride>()
    for (const item of context.overrides ?? []) {
      const alias = PromptSegmentIdAliases[item.id]
      // 两条并存只可能是跨版本升级的残留：现 id 的显式条目恒优先于旧 id 归一来的那条，
      // 因此结果与 overrides 的数组顺序无关。
      if (alias && overrides.has(alias)) continue
      overrides.set(alias ?? item.id, item)
    }

    for (const definition of this.sortedDefinitions(context)) {
      // suppressions 是运行时临时禁用，优先级高于配置覆盖。
      const suppression = this.suppressions.get(definition.id)
      if (suppression) {
        skipped.push(this.createSkipped(definition, suppression.reason))
        continue
      }

      const override = overrides.get(definition.id)
      if (override && !override.enabled) {
        skipped.push(
          this.createSkipped(
            definition,
            override.reason ?? 'disabled by persisted prompt configuration'
          )
        )
        continue
      }

      // when 可以根据 facts/context 决定是否注入。
      if (definition.when && !definition.when(context)) {
        skipped.push(this.createSkipped(definition, 'activation predicate returned false'))
        continue
      }

      // 空渲染结果会进入 skipped trace，方便调试为什么没进 prompt。
      const text = definition.render(context)?.trim()
      if (!text) {
        skipped.push(this.createSkipped(definition, 'empty render result'))
        continue
      }

      contributions.push({
        id: definition.id,
        label: definition.label,
        tier: definition.tier,
        stability: resolvePromptSegmentStability(definition.tier),
        source: definition.source,
        priority: definition.priority,
        retention: definition.retention ?? 'normal',
        text,
      })
    }

    return {
      stableParts: contributions.filter((part) => part.stability === 'stable'),
      dynamicParts: contributions.filter((part) => part.stability === 'dynamic'),
      skipped,
    }
  }

  /** 克隆注册表，供 ContextBuilder 链式变体隔离修改。 */
  public clone(): PromptRegistry {
    const clone = new PromptRegistry([...this.definitions.values()])
    for (const provider of this.providers.values()) {
      clone.registerProvider(provider)
    }
    for (const [id, suppression] of this.suppressions.entries()) {
      clone.suppress(id, suppression.reason)
    }
    return clone
  }

  /** 加载 provider 段并按 priority/id 稳定排序。 */
  private sortedDefinitions(context: PromptRenderContext): PromptSegmentDefinition[] {
    const definitions = new Map(this.definitions)
    for (const provider of this.providers.values()) {
      for (const definition of provider.load(context)) {
        // provider 是动态加载器，段在这里才第一次出现——`register` 的拦截够不着它，
        // 合并点必须重跑同一条断言，否则 Tier0 无谓词只在静态注册面成立。
        assertCorePromptSegmentHasNoPredicate(definition)
        definitions.set(definition.id, definition)
      }
    }

    return [...definitions.values()].sort((left, right) => {
      // 层序先于 priority：Tier2 恒排在 Tier1 之后，装配顺序不依赖各段自己挑的 priority 数值。
      const tierDelta = PromptSegmentTierRank[left.tier] - PromptSegmentTierRank[right.tier]
      if (tierDelta !== 0) return tierDelta
      if (left.priority !== right.priority) return left.priority - right.priority

      // P7-2：段序即 prompt 字节序，禁 locale 相关比较。
      return compareStableStrings(left.id, right.id)
    })
  }

  /** 构建 skipped trace。 */
  private createSkipped(
    definition: PromptSegmentDefinition,
    reason: string
  ): PromptCompositionResult['skipped'][number] {
    return {
      id: definition.id,
      label: definition.label,
      stability: resolvePromptSegmentStability(definition.tier),
      source: definition.source,
      priority: definition.priority,
      reason,
    }
  }
}

export { PromptRegistry, PromptSegmentTierRank, resolvePromptSegmentStability }
export type {
  PromptBudgetOptions,
  PromptCompositionResult,
  PromptContribution,
  PromptRenderContext,
  PromptSegmentDefinition,
  PromptSegmentProvider,
  PromptSegmentRetention,
  PromptSegmentSource,
  PromptSegmentStability,
  PromptSegmentTier,
}
