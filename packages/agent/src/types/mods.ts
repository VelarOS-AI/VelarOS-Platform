/**
 * Kernel pack 描述符的结构化契约。
 *
 * 与 Kernel client 的 `KernelModPackDescriptor` 同形：`specifier` 指向 pack 包目录，
 * `provides` 列出该 pack 贡献的能力 id。
 */
import type { AgentModPackReader } from '../contract/requires.js'

import type { AgentModContributionAxisName, AgentModDiagnostic, AgentModExecutionModeContribution, AgentModHookContribution, AgentModHookExecutionMode,AgentModHookMatcher, AgentModManifest, AgentModPromptSegmentContribution, AgentModSeamKind, AgentModSkillContribution, AgentModSpaceContribution, AgentModSubAgentTypeContribution, AgentModToolCategoryContribution, AgentModToolContribution, AgentModTrustLevel, AgentModTurnContextSourceContribution, ToolCategoryDefinition } from './agent.js'
import type { VelaTool } from './builtin.js'
import type { SubAgentTypeDescriptor } from './delegation.js'
import type { AgentSkillDefinition,PromptSegmentDefinition } from './guidance.js'
import type { ExecutionModeDescriptor } from './runner.js'

export interface AgentModPackDescriptorLike {
  readonly id: string
  readonly version: string
  readonly enabled: boolean
  readonly provides: readonly string[]
  readonly specifier: string
  readonly kind?: string
}

export interface AgentModDiscoveryResult {
  readonly packages: readonly AgentModPackage[]
  readonly diagnostics: readonly AgentModDiagnostic[]
}

/**
 * Mod 注册表的最小形状：九条贡献轴的登记与快照这一面。
 * 类实现在 impl/mods/AgentModRegistry.ts。
 */
export interface AgentModRegistryApi {
  /** 当前代号；每次 endRegistration 递增，快照据此判新旧。 */
  readonly generation: number
  /** 当前处于注册阶段还是已封存。 */
  getPhase(): AgentModRegistryPhase
  /** 打开注册阶段。 */
  beginRegistration(): void
  /** 关闭注册阶段并返回新的代号。 */
  endRegistration(): number
  /** 某条轴上是否已登记这个主键。 */
  has(axis: AgentModContributionAxisName, key: string): boolean
  /** 某条轴上这个主键归谁。 */
  findOwner(axis: AgentModContributionAxisName, key: string): Nullable<string>
  /** 往某条轴上登记一条贡献。 */
  register<TAxis extends AgentModContributionAxisName>(axis: TAxis, record: AgentModAxisRecord<TAxis>): void
  /** 摘除某个 mod 在全部轴上的贡献，返回摘掉的条数。 */
  removeMod(modId: string): number
  /** 列出某条轴上的全部贡献。 */
  listAxis<TAxis extends AgentModContributionAxisName>(axis: TAxis): ReadonlyArray<AgentModAxisRecord<TAxis>>
  /** 取一份原子快照。 */
  snapshot(): AgentModRegistrySnapshot
  /** 快照是否已经过期。 */
  isStale(snapshot: AgentModRegistrySnapshot): boolean
  /** 快照过期即抛。 */
  assertFresh(snapshot: AgentModRegistrySnapshot): void
}

/**
 * Mod 装载机的最小形状：装载、停用、出报告这一面。
 * 类实现在 impl/mods/AgentModLoader.ts。
 */
export interface AgentModLoaderApi {
  /** 本次装载写进去的注册表。 */
  readonly registry: AgentModRegistryApi
  /** 钩子派发台。 */
  readonly hooks: AgentModSeamDispatcherApi
  /** @deprecated 新调用方使用 `hooks`。 */
  readonly seams: AgentModSeamDispatcherApi
  /** 装载一批候选包；重复调用会在既有注册表之上继续追加（id/主键冲突照样拒载）。 */
  load(packages: readonly AgentModPackage[]): AgentModLoadReport
  /** 停用一个 mod：摘除其全部贡献与钩子；用户数据一律保留。 */
  deactivate(modId: string): boolean
  /** 最近一次装载报告。 */
  getReport(): AgentModLoadReport
  /** 当前注册表快照。 */
  snapshot(): AgentModRegistrySnapshot
}

/**
 * Mod 钩子派发台的最小形状：登记、封存与四条派发通道。
 * 类实现在 impl/mods/AgentModSeamDispatcher.ts。
 */
export interface AgentModSeamDispatcherApi {
  /** 打开 registration 阶段（Loader 装载前调用）。 */
  beginRegistration(): void
  /** 关闭 registration 阶段；此后写入即抛。 */
  seal(): void
  /** 是否已封存。 */
  isSealed(): boolean
  /** 登记一个钩子。 */
  register<TKind extends AgentModSeamKind>(input: AgentModSeamRegistrationInput<TKind>): void
  /** 摘除某 mod 的全部钩子（deactivate 用），返回摘掉的条数。 */
  removeMod(modId: string): number
  /** 某类接缝上是否挂了钩子。 */
  has(kind: AgentModSeamKind): boolean
  /** 列出某类接缝上的钩子。 */
  list(kind: AgentModSeamKind): readonly AgentModSeamRegistration[]
  /** 列出派发期攒下的诊断。 */
  listDiagnostics(): readonly AgentModDiagnostic[]
  /** 工具调用前派发；第一个给出 block 的钩子即短路。 */
  dispatchToolCallBefore(event: AgentModToolCallBeforeEvent): Promise<AgentModToolCallBeforeOutcome>
  /** 工具结果派发；result/error 沿优先级顺序折叠。 */
  dispatchToolResultAfter(event: AgentModToolResultAfterEvent): Promise<AgentModToolResultAfterOutcome>
  /** 回合上下文组装派发（同步）；各钩子追加的段并集返回。 */
  dispatchTurnContextAssemble(event: AgentModTurnContextAssembleEvent): AgentModTurnContextAssembleOutcome
  /** 回合上下文组装的异步宿主入口；折叠顺序与同步入口一致。 */
  dispatchTurnContextAssembleAsync(event: AgentModTurnContextAssembleEvent): Promise<AgentModTurnContextAssembleOutcome>
  /** 会话生命周期派发（纯通知，无结果面）。 */
  dispatchSessionLifecycle(event: AgentModSessionLifecycleEvent): Promise<void>
}

export interface AssembleAgentModsInput {
  readonly host: AgentModHostProfile
  /** 随包官方 mod；缺省 = 内置轴 mod（恒加载）。传空数组可显式关掉。 */
  readonly bundled?: readonly AgentModPackage[]
  /** Kernel 报上来的 pack 清单；缺省不做 pack 发现。 */
  readonly packs?: readonly AgentModPackDescriptorLike[]
  readonly reader?: AgentModPackReader
  readonly loader?: AgentModLoaderApi
  readonly onDiagnostic?: (diagnostic: AgentModDiagnostic) => void
}

export interface AgentModAssembly {
  readonly loader: AgentModLoaderApi
  readonly report: AgentModLoadReport
}

export interface VelarModArchiveEntry {
  readonly path: string
  readonly bytes: Buffer
}

export interface VelarModPermissionDescriptor {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly risk: 'standard' | 'sensitive' | 'high'
}

export interface VelarModArchiveFinding {
  readonly severity: 'info' | 'warning' | 'blocking'
  readonly code: string
  readonly message: string
}

export interface VelarModArchiveScanReport {
  readonly scanId: string
  readonly digest: string
  readonly fileName: string
  readonly archiveBytes: number
  readonly expandedBytes: number
  readonly fileCount: number
  readonly mod: {
    readonly id: string
    readonly version: string
    readonly displayName: string
    readonly description: string
    readonly publisher: string
  }
  readonly trust: {
    readonly kind: 'marketplace-signed' | 'user-imported'
    readonly label: string
    readonly signatureKeyId: Nullable<string>
  }
  readonly permissions: readonly VelarModPermissionDescriptor[]
  readonly contributions: Readonly<Record<string, number>>
  readonly findings: readonly VelarModArchiveFinding[]
  readonly installable: boolean
}

export interface InstallScannedVelarModArchiveRequest {
  readonly scanId: string
  readonly digest: string
  readonly trustConfirmed: boolean
  readonly grantedPermissions: readonly string[]
}

export type VelarModArchiveInstallFailureReason =
  | 'archive.changed'
  | 'archive.path-escapes-root'
  | 'archive.path-unsafe'
  | 'permissions.not-declared'
  | 'trust.confirmation-required'

export interface PreparedVelarModInstall {
  readonly report: VelarModArchiveScanReport
  readonly stagingDirectory: string
  readonly grantedPermissions: readonly string[]
  cleanup(): Promise<void>
}

export interface ZipSizeData {
  compressedSize?: number
  uncompressedSize?: number
}

export interface ScannedArchive {
  report: VelarModArchiveScanReport
  path: string
  entries: readonly VelarModArchiveEntry[]
  manifest: Record<string, unknown>
}

export interface ScanSession extends ScannedArchive {
  expiresAt: number
}

/** 一条贡献记录：声明（manifest 条目）+ 运行态载荷（缺席即纯数据轴）。 */
export interface AgentModContributionRecord<TDeclaration = unknown, TPayload = unknown> {
  readonly axis: AgentModContributionAxisName
  readonly modId: string
  /** 轴内稳定主键（工具用 name，其余用 id）。 */
  readonly key: string
  readonly declaration: TDeclaration
  readonly payload: Nullable<TPayload>
}

/** 各轴的运行态载荷类型；纯数据轴为 `never`（payload 恒 null）。 */
export interface AgentModAxisPayloadMap {
  tools: VelaTool<any, any>
  toolCategories: ToolCategoryDefinition
  promptSegments: PromptSegmentDefinition
  skills: AgentSkillDefinition
  spaces: never
  subAgentTypes: SubAgentTypeDescriptor
  turnContextSources: never
  executionModes: ExecutionModeDescriptor
  hooks: AgentModSeamHandler
}

export interface AgentModAxisDeclarationMap {
  tools: AgentModToolContribution
  toolCategories: AgentModToolCategoryContribution
  promptSegments: AgentModPromptSegmentContribution
  skills: AgentModSkillContribution
  spaces: AgentModSpaceContribution
  subAgentTypes: AgentModSubAgentTypeContribution
  turnContextSources: AgentModTurnContextSourceContribution
  executionModes: AgentModExecutionModeContribution
  hooks: AgentModHookContribution
}

export type AgentModAxisRecord<TAxis extends AgentModContributionAxisName> = AgentModContributionRecord<
  AgentModAxisDeclarationMap[TAxis],
  AgentModAxisPayloadMap[TAxis]
>

/** 一份按 generation 冻结的注册表投影；跨 generation 使用即 stale。 */
export interface AgentModRegistrySnapshot {
  readonly generation: number
  readonly tools: ReadonlyArray<AgentModAxisRecord<'tools'>>
  readonly toolCategories: ReadonlyArray<AgentModAxisRecord<'toolCategories'>>
  readonly promptSegments: ReadonlyArray<AgentModAxisRecord<'promptSegments'>>
  readonly skills: ReadonlyArray<AgentModAxisRecord<'skills'>>
  readonly spaces: ReadonlyArray<AgentModAxisRecord<'spaces'>>
  readonly subAgentTypes: ReadonlyArray<AgentModAxisRecord<'subAgentTypes'>>
  readonly turnContextSources: ReadonlyArray<AgentModAxisRecord<'turnContextSources'>>
  readonly executionModes: ReadonlyArray<AgentModAxisRecord<'executionModes'>>
  readonly hooks: ReadonlyArray<AgentModAxisRecord<'hooks'>>
}

export type AgentModRegistryPhase = 'registration' | 'runtime'

/**
 * 运行态绑定：manifest 条目主键 → 该条目的运行态载荷。
 *
 * Loader 只校验、登记和投影工具对象，不执行它；工具上下文由最终宿主的 ToolRegistry 决定。
 * 因此这里刻意不把动态 pack 的工具钉成 KernelToolContext，否则带宿主扩展槽的官方工具只能
 * 靠不安全强转进来。
 */
export interface AgentModBindings {
  readonly tools?: Readonly<Record<string, VelaTool<any, any>>>
  readonly toolCategories?: Readonly<Record<string, ToolCategoryDefinition>>
  readonly promptSegments?: Readonly<Record<string, PromptSegmentDefinition>>
  readonly skills?: Readonly<Record<string, AgentSkillDefinition>>
  readonly subAgentTypes?: Readonly<Record<string, SubAgentTypeDescriptor>>
  readonly executionModes?: Readonly<Record<string, ExecutionModeDescriptor>>
  readonly hooks?: Readonly<Record<string, AgentModSeamHandler>>
}

export type AgentModSourceKind = 'bundled' | 'pack'

/** 一个待装载的候选包：未校验 manifest + 运行态绑定。 */
export interface AgentModPackage {
  readonly source: AgentModSourceKind
  /** 诊断回显用的来源（pack 目录或 bundled 标识）。 */
  readonly origin: string
  readonly manifest: unknown
  readonly bindings?: AgentModBindings
}

/** 宿主自述：兼容轴事实 + 本宿主支持的贡献轴落点集合。 */
export interface AgentModHostProfile {
  readonly hostId: string
  /** 对应 `engines.velaros`（Kernel module API 兼容轴）。 */
  readonly velarosVersion: string
  /** 对应 `engines.agent`（Agent capability API 兼容轴）。 */
  readonly agentApiVersion: string
  /** 壳级第二轴；headless 宿主不声明。 */
  readonly shellId?: string
  readonly shellVersion?: string
  readonly supportedAxes: readonly AgentModContributionAxisName[]
  /** 允许装载的信任级；缺省只放行随包官方 mod（fail-closed）。 */
  readonly allowedTrustLevels?: readonly AgentModTrustLevel[]
}

export type AgentModActivationStatus = 'active' | 'partial'

export interface AgentModActivationState {
  readonly modId: string
  readonly version: string
  /**
   * manifest 的展示元数据，缺省为空串。
   *
   * 装载态若只返回 id 与 version，宿主就无法在注册表中展示可读名称。这三个字段本来就在
   * manifest 中，装载时一并带出；它们是装载事实的一部分，不应要求每个宿主再次读取 manifest。
   */
  readonly displayName: string
  readonly description: string
  readonly publisher: string
  readonly trust: AgentModTrustLevel
  /** 由信封 `module.permissions` 投影而来的已声明权限闭集。 */
  readonly permissions: readonly string[]
  readonly source: AgentModSourceKind
  readonly origin: string
  readonly status: AgentModActivationStatus
  readonly activeAxes: readonly AgentModContributionAxisName[]
  /** 本宿主无落点、被裁剪掉的轴（partial 态的原因）。 */
  readonly absentAxes: readonly AgentModContributionAxisName[]
  readonly contributionCount: number
  /**
   * 逐轴贡献条目数（只含**真落地**的轴；缺席轴不出现，不记 0）。
   *
   * 总数早就有了，但「16 项贡献」这一个数字说不清一个 mod 到底带来了什么。宿主要按
   * 「工具 6 · 工具类别 4 · 空间 1」这样铺清单，就得有逐轴的账——它在这里是**顺手**的，
   * 注册循环本来就逐轴逐条走了一遍。
   */
  readonly contributionsByAxis: Readonly<Partial<Record<AgentModContributionAxisName, number>>>
}

export interface AgentModRejection {
  readonly modId: Nullable<string>
  readonly origin: string
  readonly diagnostics: readonly AgentModDiagnostic[]
}

export interface AgentModLoadReport {
  readonly generation: number
  readonly activated: readonly AgentModActivationState[]
  readonly rejected: readonly AgentModRejection[]
  readonly diagnostics: readonly AgentModDiagnostic[]
}

export interface ValidatedAgentMod {
  readonly manifest: AgentModManifest
  readonly bindings: AgentModBindings
  readonly source: AgentModSourceKind
  readonly origin: string
  readonly declaredAxes: readonly AgentModContributionAxisName[]
  readonly activeAxes: readonly AgentModContributionAxisName[]
  readonly absentAxes: readonly AgentModContributionAxisName[]
}

/** 工具调用前（策略门之前）。 */
export interface AgentModToolCallBeforeEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly sessionId: Nullable<string>
}

/**
 * 工具调用前结果。
 *
 * `block` 只能**减少**可执行面；没有任何「允许」语义的字段（性质②）。
 * `args` 改写后仍要过完整策略门与参数校验。
 */
export interface AgentModToolCallBeforeOutcome {
  block?: { reason: string }
  args?: Record<string, unknown>
}

/** 工具结果收敛后（结果已产生，尚未交回调用方）。 */
export interface AgentModToolResultAfterEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly result: unknown
  readonly error: Nullable<string>
  readonly sessionId: Nullable<string>
}

export interface AgentModToolResultAfterOutcome {
  result?: unknown
  error?: string
}

/** 回合上下文组装：段已排序、预算裁剪之前。 */
export interface AgentModTurnContextSegmentView {
  readonly id: string
  readonly stability: 'stable' | 'dynamic'
  readonly source: string
  readonly priority: number
}

export interface AgentModTurnContextAssembleEvent {
  readonly stableSegments: readonly AgentModTurnContextSegmentView[]
  readonly dynamicSegments: readonly AgentModTurnContextSegmentView[]
}

/** 追加的动态段；与内置段同样计入预算裁剪（不得绕过治理预算）。 */
export interface AgentModTurnContextAppendage {
  id: string
  text: string
  label?: string
  priority?: number
}

export interface AgentModTurnContextAssembleOutcome {
  append?: readonly AgentModTurnContextAppendage[]
}

/** 会话生命周期（托管执行的进入/离开）。 */
export interface AgentModSessionLifecycleEvent {
  readonly phase: 'start' | 'end'
  readonly executionId: Nullable<string>
  readonly sessionId: Nullable<string>
  readonly status: Nullable<string>
}

export interface AgentModSeamGenericEvent {
  readonly payload: unknown
}

export interface AgentModSeamEventMap {
  'session:start': AgentModSessionLifecycleEvent
  'session:end': AgentModSessionLifecycleEvent
  'turn:start': AgentModSeamGenericEvent
  'turn:end': AgentModSeamGenericEvent
  'turn-context:assemble': AgentModTurnContextAssembleEvent
  'prompt:compose': AgentModSeamGenericEvent
  'tool-call:before': AgentModToolCallBeforeEvent
  'tool-call:after': AgentModSeamGenericEvent
  'tool-result:after': AgentModToolResultAfterEvent
  'model-request:before': AgentModSeamGenericEvent
  'model-response:after': AgentModSeamGenericEvent
  'sub-agent:dispatch': AgentModSeamGenericEvent
  'compaction:before': AgentModSeamGenericEvent
  'skill:select': AgentModSeamGenericEvent
  'diagnostic:publish': AgentModSeamGenericEvent
}

export interface AgentModSeamOutcomeMap {
  'session:start': void
  'session:end': void
  'turn:start': void
  'turn:end': void
  'turn-context:assemble': AgentModTurnContextAssembleOutcome
  'prompt:compose': void
  'tool-call:before': AgentModToolCallBeforeOutcome
  'tool-call:after': void
  'tool-result:after': AgentModToolResultAfterOutcome
  'model-request:before': void
  'model-response:after': void
  'sub-agent:dispatch': void
  'compaction:before': void
  'skill:select': void
  'diagnostic:publish': void
}

/**
 * 所有 Hook 载体共用的上下文。
 *
 * `signal` 在超时时会 abort；编译期 binding 可以直接响应，外部 command 适配器则用它
 * 终止子进程。这个第二参数不破坏现有的单参函数 binding。
 */
export interface AgentModHookContext {
  readonly modId: string
  readonly hookId: string
  readonly event: AgentModSeamKind
  readonly signal: AbortSignal
}

export type AgentModSeamHandler<TKind extends AgentModSeamKind = AgentModSeamKind> = (
  event: AgentModSeamEventMap[TKind],
  context: AgentModHookContext
) =>
  | AgentModSeamOutcomeMap[TKind]
  | void
  | Promise<AgentModSeamOutcomeMap[TKind] | void>

export interface AgentModSeamRegistrationInput<
  TKind extends AgentModSeamKind = AgentModSeamKind,
> {
  readonly modId: string
  readonly id: string
  readonly event: TKind
  readonly priority?: number
  readonly matcher?: AgentModHookMatcher
  readonly mode?: AgentModHookExecutionMode
  readonly timeoutMs?: number
  readonly handler: AgentModSeamHandler<TKind>
}

export interface AgentModSeamRegistration {
  readonly modId: string
  readonly id: string
  readonly event: AgentModSeamKind
  readonly priority: number
  readonly matcher?: AgentModHookMatcher
  readonly mode: AgentModHookExecutionMode
  readonly timeoutMs: number
  readonly handler: AgentModSeamHandler
}

/**
 * `AgentModSeamDispatcherApi` 上每个真实派发方法的名字（类型层派生，不手写）。
 *
 * 下面的 {@link WiredSeamKindsByDispatcher} 对本联合保持穷举：新增一个 `dispatch*` 方法却忘了
 * 登记它派发哪些 kind = 编译红，而不是又长出一条「注册得进、永远不触发」的哑接缝。
 */
export type AgentModSeamDispatchMethodName = {
  [K in keyof AgentModSeamDispatcherApi]: K extends `dispatch${string}` ? K : never
}[keyof AgentModSeamDispatcherApi]

/**
 * 一代 Mod 注册表对应的一份完整 Agent Surface。
 *
 * 宿主只消费这一份原子快照，不再分别读取九条贡献轴后自行拼接，避免同一回合混入
 * 不同 generation 的工具、空间或策略。
 */
export interface AgentModSurfaceSnapshot {
  readonly generation: number
  readonly tools: Readonly<Record<string, VelaTool<any, any>>>
  readonly toolCategoryByName: Readonly<Record<string, string>>
  readonly toolCategories: Readonly<Record<string, ToolCategoryDefinition>>
  readonly promptSegments: readonly PromptSegmentDefinition[]
  readonly skills: readonly AgentSkillDefinition[]
  readonly spaces: readonly AgentModSpaceContribution[]
  readonly subAgentTypes: readonly SubAgentTypeDescriptor[]
  readonly turnContextSources: readonly AgentModTurnContextSourceContribution[]
  readonly executionModes: readonly ExecutionModeDescriptor[]
  readonly hooks: AgentModRegistrySnapshot['hooks']
}

// 兼容别名：外面按 Hook 叫这些名字，包内声明按 Seam 命名（第 6 步收口时统一）。
export type {
  AgentModSeamEventMap as AgentModHookEventMap,
  AgentModSeamGenericEvent as AgentModHookGenericEvent,
  AgentModSeamHandler as AgentModHookHandler,
  AgentModSeamOutcomeMap as AgentModHookOutcomeMap,
  AgentModSeamRegistration as AgentModHookRegistration,
  AgentModSeamRegistrationInput as AgentModHookRegistrationInput,
}
