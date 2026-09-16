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
import type { AgentChatRuntimeConfig } from '../../contract/requires.js'
import type { PromptBudgetOptions, PromptCompositionResult, PromptContribution, PromptRegistryApi, PromptRenderContext, PromptSegmentDefinition, PromptSegmentProvider } from '../../types/guidance.js'
import type { AgentModSeamDispatcherApi } from '../../types/mods.js'
import type { BuiltContext } from '../../types/runner.js'
import { createIdentityPromptSegment } from '../../utils/guidance/catalog'
import { appendModTurnContextParts, finalizePromptBuild } from '../../utils/runner/prompt-assembly'
import { AgentTuning } from '../../utils/tuning'

import type { ContextBuilderPartsApi } from './ContextBuilderParts'
import { ContextBuilderParts } from './ContextBuilderParts'

/** `ContextBuilder` 零件盒的共享实例：无状态，全仓共用一份即可。 */
export const contextBuilderHelper: ContextBuilderPartsApi = new ContextBuilderParts()















/**
 * ContextBuilder — Context Engineering 核心。
 *
 * system prompt 由多个稳定性不同的段动态组装：
 * stable 段放前面，dynamic 段放末尾，让 prompt cache 更容易命中稳定前缀。
 */
export interface ContextBuilderApi {
  /** 往**本 builder 自己的**注册表里加一个段定义，返回自身便于链式调用；宿主装配期用它安装长期存在的段，回合级的段走 `withPromptSegments`。 */
  registerPromptSegment(segment: PromptSegmentDefinition): this
  /** 派生一个带上这批回合级段的新 builder：宿主 builder 的注册表不受影响，因此上一轮的段不会残留到下一轮。 */
  withPromptSegments(segments: readonly PromptSegmentDefinition[]): ContextBuilder
  /** 注册一个能一次贡献多个段的 provider（例如按能力开关动态出段），返回自身便于链式调用。 */
  registerPromptProvider(provider: PromptSegmentProvider): this
  /** 派生一个换了身份段的新 builder：子 Agent 用它改写 Tier0 身份，而不是在渲染期按上下文改文本——后者会让稳定前缀不再逐字不变。 */
  withIdentity(identity: string): ContextBuilder
  /** 派生一个屏蔽了某个段的新 builder；`reason` 会写进 `skippedSegments`，调试面据此回答「为什么模型没看到这条」。 */
  withoutPromptSegment(id: string, reason: string): ContextBuilder
  /** 同步组装一次 system prompt：段排序 → mod 同步 seam 追加 → 预算裁剪 → 拼装，同一输入恒得同一结果。无 mod 钩子时与 `buildAsync` 结果一致。 */
  build(config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>, context?: Omit<PromptRenderContext, 'chatConfig'>, options?: { promptBudget?: LooseOptional<PromptBudgetOptions> }): BuiltContext
  /** 与 `build` 同一条装配路径，但 `turn-context:assemble` 走异步派发，允许 mod 的钩子里做 IO；实际运行的回合上下文都走这条。 */
  buildAsync(config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>, context?: Omit<PromptRenderContext, 'chatConfig'>, options?: { promptBudget?: LooseOptional<PromptBudgetOptions> }): Promise<BuiltContext>
}

class ContextBuilder implements ContextBuilderApi {
  /** prompt 段注册表，负责排序、过滤和 tier 分组。 */
  private readonly registry: PromptRegistryApi
  /**
   * 可选 mod 拦截 seam 派发器；注入时在段排序后、预算裁剪前派发一次
   * `turn-context:assemble`。追加段与内置段同样计入预算，不得绕过上下文治理。
   * 缺省 null → 全链 no-op，组装结果逐字节不变。
   */
  private readonly seams: Nullable<AgentModSeamDispatcherApi>

  constructor(
    registry: PromptRegistryApi = contextBuilderHelper.createDefaultRegistry(),
    seams: Nullable<AgentModSeamDispatcherApi> = null
  ) {
    this.registry = registry
    this.seams = seams
  }

  public registerPromptSegment(segment: PromptSegmentDefinition): this {
    this.registry.register(segment)
    return this
  }

  public withPromptSegments(segments: readonly PromptSegmentDefinition[]): ContextBuilder {
    const clone = this.clone()
    for (const segment of segments) clone.registry.register(segment)
    return clone
  }

  public registerPromptProvider(provider: PromptSegmentProvider): this {
    this.registry.registerProvider(provider)
    return this
  }

  /**
   * 覆盖 identity 段（子 Agent 场景使用）。
   *
   * 身份是 builder 作用域的常量，所以做法是在克隆出的注册表里**重新注册 Tier0 身份段**，
   * 而不是往渲染上下文里塞一个 `identity` 字段——后者等于给 Tier0 开一条"渲染期按上下文变文本"
   * 的口子，稳定前缀的逐字不变就只剩约定、不再是结构。
   *
   * 顺带修：旧实现 `new ContextBuilder(registry.clone(), identity)` **把 seams 丢了**，
   * 于是子 Agent 的 `turn-context:assemble` 接缝静默失效。
   */
  public withIdentity(identity: string): ContextBuilder {
    const clone = this.clone()
    clone.registry.register(createIdentityPromptSegment(identity))
    return clone
  }

  public withoutPromptSegment(id: string, reason: string): ContextBuilder {
    const clone = this.clone()
    clone.registry.suppress(id, reason)
    return clone
  }

  public build(
    config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>,
    context: Omit<PromptRenderContext, 'chatConfig'> = {},
    options: { promptBudget?: LooseOptional<PromptBudgetOptions> } = {}
  ): BuiltContext {
    const composition = this.registry.compose({
      ...context,
      chatConfig: config,
    })
    const dynamicParts = this.appendModTurnContext(composition)
    return finalizePromptBuild({
      composition,
      dynamicParts,
      budget: options.promptBudget,
    })
  }

  public async buildAsync(
    config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>,
    context: Omit<PromptRenderContext, 'chatConfig'> = {},
    options: { promptBudget?: LooseOptional<PromptBudgetOptions> } = {}
  ): Promise<BuiltContext> {
    const composition = this.registry.compose({
      ...context,
      chatConfig: config,
    })
    const dynamicParts = await this.appendModTurnContextAsync(composition)
    return finalizePromptBuild({
      composition,
      dynamicParts,
      budget: options.promptBudget,
    })
  }

  /**
   * mod Hook：`turn-context:assemble` 同步兼容入口。
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
    return appendModTurnContextParts({
      composition,
      appended: outcome.append ?? [],
      defaultPriority: AgentTuning.prompt.modTurnContextPriority,
    })
  }

  private async appendModTurnContextAsync(
    composition: PromptCompositionResult
  ): Promise<PromptContribution[]> {
    if (!this.seams?.has('turn-context:assemble')) return composition.dynamicParts

    const toView = (part: PromptContribution) => ({
      id: part.id,
      stability: part.stability,
      source: part.source,
      priority: part.priority,
    })
    const outcome = await this.seams.dispatchTurnContextAssembleAsync({
      stableSegments: composition.stableParts.map(toView),
      dynamicSegments: composition.dynamicParts.map(toView),
    })
    return appendModTurnContextParts({
      composition,
      appended: outcome.append ?? [],
      defaultPriority: AgentTuning.prompt.modTurnContextPriority,
    })
  }

  /** 克隆 registry，保证链式构建不会修改原始 builder。 */
  private clone(): ContextBuilder {
    return new ContextBuilder(this.registry.clone(), this.seams)
  }
}

export { ContextBuilder }
