// 域：**回合上下文组装**（系统提示词 = 提示词段注册表 × 运行态条件 × 预算 + mod 追加段）。
//
// **为什么组装在一处**：提示词是全系统最容易被「顺手加一段」腐蚀的面。收在这里才能保证
// 三件事同时成立：段的**顺序稳定**（前缀缓存命中靠它）、**预算可算**（超了要按 stability
// 与 priority 裁而不是随机丢）、**可追溯**（每段进/未进都出 trace，调试面能回答"为什么模型
// 没看到这条"）。
//
// ## 关键不变量（改这些会破什么）
//  - **稳定段在前、易变段在后**：把易变信息（时间、状态快照）塞进前缀会让 provider 侧前缀
//    缓存整轮失效——成本与延迟一起涨。每回合易变的东西走 turn-context 块或 history note。
//  - **`turn-context:assemble` seam 只能追加，不能重排/删除官方段**：mod 追加的段计入同一
//    预算，超预算按同一规则裁；给 mod 重排权 = 让它能把安全类段挤出去。
//  - **裁剪必须出 trace**（`SkippedPromptSegmentTrace`）：静默裁剪的后果是行为莫名变化且
//    无从复现——这是历史上最难查的一类问题。
//  - **组装是纯函数**：同一输入恒得同一提示词（金标轨迹逐字节比对依赖它）。
import { isEmpty } from '@velaros-ai/core'

import type { AgentModSeamDispatcher } from '../mods/AgentModSeams'
import {
  createBuiltInPromptRegistry,
  type PromptBudgetOptions,
  type PromptCompositionResult,
  type PromptContribution,
  type PromptRegistry,
  type PromptRenderContext,
  type PromptSegmentDefinition,
  type PromptSegmentProvider,
} from '../prompts'

import type { AgentChatRuntimeConfig } from './RuntimeConfiguration'

/** mod 追加段的缺省优先级：排在内置 dynamic 段之后、便于识别来源。 */
const ModTurnContextDefaultPriority = 9_000

export interface ContextSegment {
  /** 段名（用于 debug） */
  name: string
  /** stable: 很少变动，适合 prompt cache；dynamic: 每次可能不同 */
  stability: 'stable' | 'dynamic'
  /** 构建段内容 */
  build: () => Nullable<string>
}

export interface BuiltContext {
  /** 组装好的完整 system prompt */
  systemPrompt: string
  /**
   * stable 段的结束索引（在 systemPrompt 中）
   * 可用于向 LLM SDK 提示 cache 边界（未来接入 Anthropic cache_control 时用）
   */
  stableCutoff: number
  /** 参与本轮装配的 prompt 段，供 debug 和后续可视化使用 */
  segments: Array<{
    id: string
    label?: string
    stability: ContextSegment['stability']
    source: string
    priority: number
    retention: 'normal' | 'protected'
    text: string
  }>
  skippedSegments: Array<{
    id: string
    label?: string
    stability: ContextSegment['stability']
    source: string
    priority: number
    reason: string
  }>
  promptBudget: Nullable<{
    profile: string
    maxChars: number
    charsBefore: number
    charsAfter: number
    trimmedSegmentCount: number
  }>
}

class ContextBuilderParts {
  public createDefaultRegistry(): PromptRegistry {
    return createBuiltInPromptRegistry()
  }

  public fromContextSegment(segment: ContextSegment): PromptSegmentDefinition {
    return {
      id: `inline.${segment.name}`,
      label: segment.name,
      stability: segment.stability,
      source: 'inline',
      priority: segment.stability === 'stable' ? 1_000 : 5_000,
      render: () => segment.build(),
    }
  }

  public buildPromptAppend(config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>): Nullable<string> {
    return config?.systemPromptAppend?.trim() || null
  }
}

const contextBuilderHelper = new ContextBuilderParts()

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function wrapCdata(text: string): string {
  return `<![CDATA[\n${text.replaceAll(']]>', ']]]]><![CDATA[>')}\n]]>`
}

function formatPromptSection(part: PromptContribution): string {
  const name = part.label?.trim() || part.id
  return [
    `  <section name="${escapeXmlAttribute(name)}">`,
    wrapCdata(part.text),
    '  </section>',
  ].join('\n')
}

function formatPromptBlock(args: {
  name: 'instructions' | 'current_context'
  parts: PromptContribution[]
}): string {
  return [
    `<${args.name}>`,
    ...args.parts.map((part) => formatPromptSection(part)),
    `</${args.name}>`,
  ].join('\n')
}

function buildStructuredSystemPrompt(args: {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
}): { systemPrompt: string; stableCutoff: number } {
  // Prompt governance metadata belongs to `BuiltContext.segments`, not to the model. The model
  // receives only descriptive sections; stable and current blocks are independently valid XML so
  // provider delivery can move the current block behind history without splitting an XML document.
  const stablePrefix = formatPromptBlock({
    name: 'instructions',
    parts: args.stableParts,
  })

  if (isEmpty(args.dynamicParts)) return { systemPrompt: stablePrefix, stableCutoff: stablePrefix.length }

  return {
    systemPrompt: [
      stablePrefix,
      formatPromptBlock({
        name: 'current_context',
        parts: args.dynamicParts,
      }),
    ].join('\n'),
    stableCutoff: stablePrefix.length,
  }
}

function canTrimPromptPart(part: PromptContribution): boolean {
  if (part.retention === 'protected') return false
  if (part.source === 'user') return false

  return part.priority >= 1_000
}

function applyPromptBudget(args: {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
  skipped: BuiltContext['skippedSegments']
  budget?: LooseOptional<PromptBudgetOptions>
}): {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
  skipped: BuiltContext['skippedSegments']
  budgetTrace: BuiltContext['promptBudget']
} {
  if (!args.budget || args.budget.maxChars <= 0) return {
      stableParts: args.stableParts,
      dynamicParts: args.dynamicParts,
      skipped: args.skipped,
      budgetTrace: null,
    }

  const stableParts = [...args.stableParts]
  const dynamicParts = [...args.dynamicParts]
  const skipped = [...args.skipped]
  const initialPrompt = buildStructuredSystemPrompt({
    stableParts,
    dynamicParts,
  }).systemPrompt
  const charsBefore = initialPrompt.length
  let trimmedSegmentCount = 0

  while (
    buildStructuredSystemPrompt({
      stableParts,
      dynamicParts,
    }).systemPrompt.length >
    args.budget.maxChars
  ) {
    const candidates = [...stableParts, ...dynamicParts]
      .filter(canTrimPromptPart)
      .sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority

        return right.text.length - left.text.length
      })
    const candidate = candidates[0]
    if (!candidate) {
      break
    }

    const stableIndex = stableParts.findIndex((part) => part.id === candidate.id)
    if (stableIndex >= 0) {
      stableParts.splice(stableIndex, 1)
    } else {
      const dynamicIndex = dynamicParts.findIndex((part) => part.id === candidate.id)
      if (dynamicIndex >= 0) {
        dynamicParts.splice(dynamicIndex, 1)
      }
    }

    trimmedSegmentCount += 1
    skipped.push({
      id: candidate.id,
      label: candidate.label,
      stability: candidate.stability,
      source: candidate.source,
      priority: candidate.priority,
      reason: `trimmed by run profile ${args.budget.profile} (max ${args.budget.maxChars} chars)`,
    })
  }

  const charsAfter = buildStructuredSystemPrompt({
    stableParts,
    dynamicParts,
  }).systemPrompt.length

  return {
    stableParts,
    dynamicParts,
    skipped,
    budgetTrace: {
      profile: args.budget.profile,
      maxChars: args.budget.maxChars,
      charsBefore,
      charsAfter,
      trimmedSegmentCount,
    },
  }
}

/**
 * ContextBuilder — Context Engineering 核心。
 *
 * system prompt 由多个稳定性不同的段动态组装：
 * stable 段放前面，dynamic 段放末尾，让 prompt cache 更容易命中稳定前缀。
 */
class ContextBuilder {
  /** prompt 段注册表，负责排序、过滤和 stable/dynamic 分组。 */
  private readonly registry: PromptRegistry
  /** 可覆盖 identity 段，常用于 solo mode 或子 Agent。 */
  private readonly identity?: string
  /**
   * 可选 mod 拦截 seam 派发器；注入时在段排序后、预算裁剪前派发一次
   * `turn-context:assemble`。追加段与内置段同样计入预算，不得绕过上下文治理。
   * 缺省 null → 全链 no-op，组装结果逐字节不变。
   */
  private readonly seams: Nullable<AgentModSeamDispatcher>

  constructor(
    registry: PromptRegistry = contextBuilderHelper.createDefaultRegistry(),
    identity?: string,
    seams: Nullable<AgentModSeamDispatcher> = null
  ) {
    this.registry = registry
    this.identity = identity
    this.seams = seams
  }

  /** 注册自定义段（在 dynamic 段之后追加） */
  public addSegment(segment: ContextSegment): this {
    this.registry.register(contextBuilderHelper.fromContextSegment(segment))
    return this
  }

  /** 注册结构化 prompt 段定义。 */
  public registerPromptSegment(segment: PromptSegmentDefinition): this {
    this.registry.register(segment)
    return this
  }

  /** 注册一个 prompt provider，它可以一次提供多个段。 */
  public registerPromptProvider(provider: PromptSegmentProvider): this {
    this.registry.registerProvider(provider)
    return this
  }

  /** 注入动态环境信息（每次调用前更新）。 */
  public addDynamicSegment(name: string, content: string): this {
    return this.addSegment({ name, stability: 'dynamic', build: () => content })
  }

  public withSegment(
    name: string,
    stability: ContextSegment['stability'],
    content: string
  ): ContextBuilder {
    const clone = this.clone()
    clone.addSegment({ name, stability, build: () => content })
    return clone
  }

  /** 返回追加 dynamic 段后的 builder clone。 */
  public withDynamicSegment(name: string, content: string): ContextBuilder {
    return this.withSegment(name, 'dynamic', content)
  }

  /** 覆盖 identity 段（子 Agent 场景使用）。 */
  public withIdentity(identity: string): ContextBuilder {
    return new ContextBuilder(this.registry.clone(), identity)
  }

  /** 禁用某个 prompt segment，通常由系统配置的 segmentOverrides 驱动。 */
  public withoutPromptSegment(id: string, reason: string): ContextBuilder {
    const clone = this.clone()
    clone.registry.suppress(id, reason)
    return clone
  }

  /** 组装最终 system prompt，并返回段 trace，供调试面板展示。 */
  public build(
    config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>,
    context: Omit<PromptRenderContext, 'chatConfig' | 'identity'> = {},
    options: { promptBudget?: LooseOptional<PromptBudgetOptions> } = {}
  ): BuiltContext {
    const composition = this.registry.compose({
      ...context,
      chatConfig: config,
      identity: this.identity,
    })
    const dynamicParts = this.appendModTurnContext(composition)
    const budgeted = applyPromptBudget({
      stableParts: composition.stableParts,
      dynamicParts,
      skipped: composition.skipped,
      budget: options.promptBudget,
    })
    const { systemPrompt, stableCutoff } = buildStructuredSystemPrompt({
      stableParts: budgeted.stableParts,
      dynamicParts: budgeted.dynamicParts,
    })

    return {
      systemPrompt,
      stableCutoff,
      segments: [...budgeted.stableParts, ...budgeted.dynamicParts].map((part) => ({
        id: part.id,
        label: part.label,
        stability: part.stability,
        source: part.source,
        priority: part.priority,
        retention: part.retention,
        text: part.text,
      })),
      skippedSegments: budgeted.skipped.map((part) => ({
        id: part.id,
        label: part.label,
        stability: part.stability,
        source: part.source,
        priority: part.priority,
        reason: part.reason,
      })),
      promptBudget: budgeted.budgetTrace,
    }
  }

  /**
   * mod 接缝：`turn-context:assemble` 同步派发。
   *
   * 缺省或无钩子时原样返回 composition.dynamicParts（同一数组引用，零分配）。
   */
  private appendModTurnContext(
    composition: PromptCompositionResult
  ): PromptContribution[] {
    if (!this.seams?.has('turn-context:assemble')) return composition.dynamicParts

    const toView = (part: PromptContribution) => ({
      id: part.id,
      stability: part.stability,
      source: part.source,
      priority: part.priority,
    })
    const outcome = this.seams.dispatchTurnContextAssemble({
      stableSegments: composition.stableParts.map(toView),
      dynamicSegments: composition.dynamicParts.map(toView),
    })
    const appended = outcome.append ?? []
    if (appended.length === 0) return composition.dynamicParts

    const known = new Set(
      [...composition.stableParts, ...composition.dynamicParts].map((part) => part.id)
    )
    const extras: PromptContribution[] = []
    for (const item of appended) {
      const text = item.text.trim()
      if (isEmpty(text) || known.has(item.id)) continue
      known.add(item.id)
      extras.push({
        id: item.id,
        label: item.label,
        stability: 'dynamic',
        source: 'mod',
        priority: item.priority ?? ModTurnContextDefaultPriority,
        retention: 'normal',
        text,
      })
    }
    if (isEmpty(extras)) return composition.dynamicParts

    return [...composition.dynamicParts, ...extras].sort(
      (left, right) => left.priority - right.priority
    )
  }

  /** 克隆 registry，保证链式构建不会修改原始 builder。 */
  private clone(): ContextBuilder {
    return new ContextBuilder(this.registry.clone(), this.identity, this.seams)
  }
}

export { ContextBuilder, contextBuilderHelper, ContextBuilderParts }
export { ContextBuilderParts as ContextBuilderHelper }
