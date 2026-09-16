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
import { AppError } from '@velaros-ai/core/error'

import type { PromptSegmentOverride } from '../../types/agent.js'
import type { BuiltInPromptOptions,PromptCompositionResult,PromptContribution,PromptRenderContext, PromptSegmentDefinition, PromptSegmentProvider, PromptSegmentStability, PromptSegmentTier, PromptSuppression } from '../../types/guidance.js'
import { createBuiltInPromptSegments } from '../../utils/guidance/catalog'
import { createSkippedPromptSegment } from '../../utils/guidance/shared'
import { compareStableStrings } from '../../utils/residency/determinism'
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

/**
 * Prompt 段注册表对外的面：装配期把各处的段注册进来，每一轮再按 `(tierRank, priority, id)`
 * 组合出这轮 system prompt 的稳定前缀与活动尾。
 *
 * 一份注册表归一个 ContextBuilder 持有，状态（静态段、provider、运行时压制）全在实例内存里、
 * 不落盘；派生子 Agent 或换 surface 时用 `clone()` 隔离，免得一次 `suppress` 泄漏到别的变体。
 * 排序键与分层规则见文件头，破坏它等于让前缀缓存跨机器失效。实现是 `PromptRegistry`。
 */
export interface PromptRegistryApi {
  /**
   * 注册或按 id 覆盖一个静态段，返回自身好串着写。
   * Tier0（`core`）段带 `when` 谓词时当场抛 `VALIDATION`——稳定前缀必须逐轮字节不变。
   */
  register(definition: PromptSegmentDefinition): this
  /** 按数组顺序逐个 `register`，返回自身；同 id 后来者覆盖先来者。 */
  registerMany(definitions: PromptSegmentDefinition[]): this
  /**
   * 注册一个动态段 provider，返回自身。provider 在每次 `compose` 时才按当轮上下文吐段，
   * 吐出来的段同样要过 Tier0 无谓词断言；同 id 的 provider 后注册的覆盖先注册的。
   */
  registerProvider(provider: PromptSegmentProvider): this
  /**
   * 运行时临时关掉某个段并记下原因，返回自身。优先级最高：盖过持久化 overrides 与 `when` 谓词。
   * 被关掉的段会带着这条 reason 进 `skipped`，不是凭空消失。
   */
  suppress(id: string, reason: string): this
  /** 撤销一次 `suppress`，返回自身；该段此后重新受 overrides 与 `when` 支配。没压制过也不报错。 */
  restore(id: string): this
  /**
   * 组合出这一轮的提示词段：静态段并上 provider 当轮吐的段，按层序→priority→id 排定，
   * 逐段过压制 / 持久化 overrides / `when` 谓词 / 空渲染四道闸，通过的按稳定性分进
   * `stableParts` 与 `dynamicParts`，被拦下的连同 reason 进 `skipped`。不传上下文即按空上下文算。
   */
  compose(context?: PromptRenderContext): PromptCompositionResult
  /**
   * 复制一份注册表：定义与运行时压制态各复制一份，provider 引用共享（provider 无状态）。
   * ContextBuilder 派生变体时用它做隔离，改克隆体不会碰到原表。
   */
  clone(): PromptRegistry
}

/**
 * Prompt 段注册表。
 *
 * ContextBuilder 使用它组合 system prompt：
 * - definitions 是静态注册段。
 * - providers 可按当前上下文动态生成段。
 * - suppressions/overrides 可以禁用某些段。
 */
class PromptRegistry implements PromptRegistryApi {
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
        skipped.push(
          createSkippedPromptSegment(
            definition,
            suppression.reason,
            resolvePromptSegmentStability(definition.tier)
          )
        )
        continue
      }

      const override = overrides.get(definition.id)
      if (override && !override.enabled) {
        skipped.push(
          createSkippedPromptSegment(
            definition,
            override.reason ?? 'disabled by persisted prompt configuration',
            resolvePromptSegmentStability(definition.tier)
          )
        )
        continue
      }

      // when 可以根据 facts/context 决定是否注入。
      if (definition.when && !definition.when(context)) {
        skipped.push(
          createSkippedPromptSegment(
            definition,
            'activation predicate returned false',
            resolvePromptSegmentStability(definition.tier)
          )
        )
        continue
      }

      // 空渲染结果会进入 skipped trace，方便调试为什么没进 prompt。
      const text = definition.render(context)?.trim()
      if (!text) {
        skipped.push(
          createSkippedPromptSegment(
            definition,
            'empty render result',
            resolvePromptSegmentStability(definition.tier)
          )
        )
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

}

/**
 * 建一份带内置段的提示词目录：段目录（`utils/guidance/catalog.ts`）算出内置段，这里装进登记处。
 *
 * 返回类型保持具体类而不是 `PromptRegistryApi`：宿主（Desktop）把它标注成 `PromptRegistry` 存字段，
 * 收窄成接口会让那边编译不过。等导出面收口那一轮把类整体收进接口时再一起改。
 */
function createBuiltInPromptRegistry(options: BuiltInPromptOptions = {}): PromptRegistry {
  return new PromptRegistry(createBuiltInPromptSegments(options))
}

export { createBuiltInPromptRegistry,PromptRegistry, PromptSegmentTierRank, resolvePromptSegmentStability }
