/** Prompt 段稳定性：stable 适合缓存，dynamic 每轮可能变化。由 tier 派生，不再由段自报。 */
import type { SkillFileStoreApi } from '../contract/provides.js'
import type { AgentChatRuntimeConfig } from '../contract/requires.js'

import type { AgentContextPhase, AgentDeveloperContext, AgentRoleId, AgentSkillDescriptor, AgentSurfaceId, AppLocale, CapabilityScopeId, ChatPromptFeatureId, PromptSegmentOverride, RunProfileId, ThinkingDepth, ToolOsState, ToolSurfaceProfileId, WorkflowType } from './agent.js'
import type { SubAgentDispatchCatalog } from './delegation.js'

export type PromptSegmentStability = 'stable' | 'dynamic'

/**
 * 行为知识三层。
 *
 * - `core`：Tier0，身份 / 安全 / 不可变纪律。进稳定前缀，逐字不变，极小。
 * - `runtime`：Tier1，按会话状态装配的运行态指导（空间、执行模式、工具面、能力协议）。
 * - `skill`：Tier2，工艺知识（怎么做好某类任务）。descriptor 常驻、选中才注入全文。
 */
export type PromptSegmentTier = 'core' | 'runtime' | 'skill'

/** protected 段属于上下文保护区，不允许被运行配置的 prompt 预算裁剪。 */
export type PromptSegmentRetention = 'normal' | 'protected'

/** Prompt 段来源，用于调试面板解释每段从哪里来。 */
export type PromptSegmentSource = string

export interface PromptBudgetOptions {
  profile: string
  maxChars: number
}

export interface PromptRenderContext {
  /** 聊天配置，主要读取用户追加 system prompt。 */
  chatConfig?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>
  /** 运行时事实，供 when/render 判断。 */
  facts?: Record<string, unknown>
  /** 持久化 prompt 段启停覆盖。 */
  overrides?: PromptSegmentOverride[]
}

export interface PromptSegmentDefinition {
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

export interface PromptSegmentProvider {
  /** provider id。 */
  id: string
  /** 根据当前渲染上下文动态加载段定义。 */
  load: (context: PromptRenderContext) => PromptSegmentDefinition[]
}

export interface PromptContribution {
  id: string
  label?: string
  tier: PromptSegmentTier
  stability: PromptSegmentStability
  source: PromptSegmentSource
  priority: number
  retention: PromptSegmentRetention
  text: string
}

export interface PromptSuppression {
  /** 跳过原因。 */
  reason: string
}

export interface PromptCompositionResult {
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

/** 单个技能文件的解析结果（frontmatter + 正文）。 */
export interface SkillFileRecord {
  /** slug = 文件名（不含 .md），也是全链路引用的 skill id。 */
  id: string
  name: string
  description: string
  version: Nullable<string>
  filePath: string
  updatedAt: number
  enabled: boolean
  /** 去掉 frontmatter 的正文。 */
  markdown: string
  /** 可见能力作用域（frontmatter `spaces: [scope-a, scope-b]`）；必填且非空。 */
  spaces: string[]
  /** 索引排序优先级（frontmatter `priority: 60`）；越小越靠前，空用 provider 默认。 */
  priority: Nullable<number>
  /** 调用提示（frontmatter `argument-hint`）：告诉模型/用户这个技能期望怎样的输入。 */
  argumentHint: Nullable<string>
  /** 每技能工具门控（frontmatter `allowed-tools: [a, b]`）；空 = 不限制。 */
  allowedTools: string[]
  /** 目录式技能（<id>/SKILL.md）的根目录；平铺单文件为 null。 */
  baseDir: Nullable<string>
  /** 目录式技能的捆绑资源相对路径（不含 SKILL.md/隐藏文件；有限深度与数量）。 */
  resourcePaths: string[]
}

export interface SkillFrontmatter {
  data: Record<string, string>
  body: string
}

/**
 * 远端 manifest 条目：
 * `{ skills: [{ id, name, description, version, file, sha256? }] }`
 * 由 scripts/build/packageSkillMarket.mjs 生成，托管在 market base 下。
 */
export interface RemoteSkillEntry {
  id: string
  name: string
  description: string
  version: string
  file: string
  sha256?: string
}

export type SkillMarketAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reason: 'endpoint-not-configured' }>

/**
 * 技能类型——行为知识三层模型里 Tier2 的两个子类，决定注入方式：
 *  - role：角色身份技能。当前角色命中即注入全文常驻（Tier2 常驻档）。只应由受信任的内置角色供应方产出。
 *  - capability：能力技能。descriptor 常驻、正文按需 tooling:read；命中 feature/选中后只注入 skill:<id> 指针。
 */
export type AgentSkillKind = 'role' | 'capability'

/**
 * 智能体技能定义。
 * - 继承技能描述，增加完整文档内容，用于 tooling:read 按需读取。
 * - kind='role' 由内置角色供应方注册，命中角色即注入全文；
 *   kind='capability' 命中后只注入 skill:<id> 链接，正文按需读取。
 */
export interface AgentSkillDefinition extends AgentSkillDescriptor {
  markdown: string
  /** 目录式技能（<id>/SKILL.md）的根目录；平铺单文件技能为空。 */
  baseDir?: string
  /** 目录式技能的捆绑资源相对路径清单（渐进披露第三层，tooling:read skill:<id>/<路径> 按需读取）。 */
  resourcePaths?: readonly string[]
  /** 项目级技能的来源项目根：仅当会话活跃根等于它时可见（根级精筛）。 */
  sourceResourceId?: string
  /** 用户可暂停技能；禁用后不参与列表、自动命中或 tooling:read。 */
  enabled: boolean
  /** 技能类型：决定注入方式（role=全文常驻，capability=指针+按需）。与 sourceKind（来源）区分。 */
  skillKind: AgentSkillKind
  /**
   * 哪些 Prompt Feature 开启时命中该技能。
   *
   * 用于用户显式开启的高成本能力；命中后只注入 skill:<id> 链接。
   */
  autoInjectPromptFeatures?: readonly ChatPromptFeatureId[]
  /**
   * 技能可见/可触发的能力作用域。
   *
   * 必填且非空；通用 Skill 也必须由宿主显式列出全部空间，新增空间时重新作出可见性裁决。
   */
  capabilityScopes: readonly CapabilityScopeId[]
}

export interface RuntimePromptToolSummary {
  name: string
  description: string
}

export interface RuntimePromptToolCategorySummary {
  id: string
  label: string
  description: string
  enabled: boolean
  toolOsDefaultState: ToolOsState
  tools: RuntimePromptToolSummary[]
  hiddenToolCount: number
}

export interface RuntimePromptCustomSubAgent {
  id: string
  description: string
  base: string
}

/** Host-neutral snapshot passed to prompt contributors. */
export interface RuntimePromptSnapshot {
  locale: AppLocale
  roleId: AgentRoleId
  roleLabel: string
  workflowType: WorkflowType
  thinkingDepth: ThinkingDepth
  developerContext: Nullable<AgentDeveloperContext>
  agentSurfaceId: AgentSurfaceId
  contextPhase: AgentContextPhase
  activeCapabilityScope: CapabilityScopeId
  toolCategories: string[]
  toolSurfaceProfile: ToolSurfaceProfileId
  runProfile: RunProfileId
  toolCapabilityCategories: RuntimePromptToolCategorySummary[]
  requestableToolCapabilityCategories: RuntimePromptToolCategorySummary[]
  canUpdatePlan: boolean
  userRequestedPlan: boolean
  goalMode: boolean
  selectedPromptFeatureLabels: string[]
  enabledPromptFeatures: ChatPromptFeatureId[]
  autoPromptFeatureLabels: string[]
  availableSkills: AgentSkillDescriptor[]
  customSubAgents: RuntimePromptCustomSubAgent[]
  subAgentDispatchCatalog?: SubAgentDispatchCatalog
  executionPlanPreview: Nullable<string>
  currentExecutionAdvice: Nullable<string>
  recentToolFailures: string[]
  hasCompactedContext: boolean
}

export interface BuiltInPromptOptions {
  /**
   * 宿主为主 Agent 提供的身份说明。
   *
   * 身份由应用装配；未提供时使用产品中性的默认身份。
   */
  primaryAgentIdentity?: string
}

/**
 * 提示词段注册表的最小形状：注册、屏蔽、组合这一面。
 * 类实现在 impl/guidance/PromptRegistry.ts。
 */
export interface PromptRegistryContract {
  /** 注册或覆盖单个 prompt 段（Tier0 带谓词即抛）。 */
  register(definition: PromptSegmentDefinition): this
  /** 批量注册 prompt 段。 */
  registerMany(definitions: PromptSegmentDefinition[]): this
  /** 注册动态段 provider。 */
  registerProvider(provider: PromptSegmentProvider): this
  /** 运行时禁用某个段。 */
  suppress(id: string, reason: string): this
  /** 恢复被 suppress 的段。 */
  restore(id: string): this
  /** 组合所有可用段，并返回 stable/dynamic/skipped 分组结果。 */
  compose(context?: PromptRenderContext): PromptCompositionResult
  /** 克隆注册表，供 ContextBuilder 链式变体隔离修改。 */
  clone(): PromptRegistryContract
}

/**
 * 建 `SkillFileStore` 要的外部依赖：技能目录在哪、以及外部 Skill 没声明 spaces 时兜底给哪些空间。
 * 由宿主在装配期一次性递入，建好之后不再变。
 */
export interface SkillFileStoreDependencies {
  /** 技能目录解析器由宿主递入；桌面和 headless 宿主可使用各自的数据根。 */
  skillsDir: () => string
  /** 兼容没有声明 spaces 的外部 Skill；为空时保持 Platform 的 fail-closed 必填语义。 */
  defaultSpaces?: readonly string[]
}

export interface SkillMarketClientDependencies {
  store: SkillFileStoreApi
  /**
   * 宿主提供的市场根地址。未注入或返回空值时，市场保持禁用且网络请求不会发生。
   */
  marketBase?: () => string
  fetchImpl?: typeof fetch
  now?: () => number
}
