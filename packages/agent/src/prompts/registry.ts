import type { PromptSegmentOverride } from '@velaros-ai/core/types'

import type { AgentChatRuntimeConfig } from '../agent/RuntimeConfiguration'
/** Prompt 段稳定性：stable 适合缓存，dynamic 每轮可能变化。 */
type PromptSegmentStability = 'stable' | 'dynamic'
/** protected 段属于上下文保护区，不允许被运行配置的 prompt 预算裁剪。 */
type PromptSegmentRetention = 'normal' | 'protected'
/** Prompt 段来源，用于调试面板解释每段从哪里来。 */
type PromptSegmentSource = string

interface PromptBudgetOptions {
  profile: string
  maxChars: number
}

interface PromptRenderContext {
  /** 可覆盖身份段。 */
  identity?: string
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
  /** stable/dynamic 分组。 */
  stability: PromptSegmentStability
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
class SegmentRegistry {
  /** 静态 prompt 段定义。 */
  private readonly definitions = new Map<string, PromptSegmentDefinition>()
  /** 动态 prompt 段 provider。 */
  private readonly providers = new Map<string, PromptSegmentProvider>()
  /** 运行时禁用段。 */
  private readonly suppressions = new Map<string, PromptSuppression>()

  constructor(definitions: PromptSegmentDefinition[] = []) {
    this.registerMany(definitions)
  }

  /** 注册或覆盖单个 prompt 段。 */
  public register(definition: PromptSegmentDefinition): this {
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
    const overrides = new Map((context.overrides ?? []).map((item) => [item.id, item]))

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
        stability: definition.stability,
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
  public clone(): SegmentRegistry {
    const clone = new SegmentRegistry([...this.definitions.values()])
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
        definitions.set(definition.id, definition)
      }
    }

    return [...definitions.values()].sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority

      return left.id.localeCompare(right.id)
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
      stability: definition.stability,
      source: definition.source,
      priority: definition.priority,
      reason,
    }
  }
}

export { SegmentRegistry }
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
}
export { SegmentRegistry as PromptRegistry }
