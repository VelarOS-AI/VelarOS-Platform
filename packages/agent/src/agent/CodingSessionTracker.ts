import { isArray, isEmpty, isFiniteNumber, isNumber, isObject, isPlainObject, isPositiveNumber,isPresent, isString, isTrue, toNullable } from '@velaros-ai/core'
import {
  assertRunProfileSelectionId,
  assertToolSurfaceProfileId,
  resolveRunProfileSelectionId,
  resolveToolSurfaceProfileId,
} from '@velaros-ai/core/constants/typedFieldAsserts'
import type {
  CapabilityAutoApprovalNotice,
  CapabilityScopeId,
  ChatPromptFeatureId,
  RunProfileSelectionId,
  ThinkingDepth,
  ToolCategoryId,
  ToolLayerTelemetryMetrics,
  ToolSurfaceProfileId,
  TurnPlanningTelemetryPayload,
} from '@velaros-ai/core/types'

const DefaultEnabledPromptFeatures: readonly ChatPromptFeatureId[] = []
import type {
  CapabilityValidationInterpreter,
  CapabilityValidationRunResult,
  CapabilityValidationStatus,
} from '../capabilities'
import {
  CodingSessionEditResultHelper,
  CodingSessionVerificationHelper,
  CodingToolCallDeduper,
} from '../coding'
import type {
  CodingSessionSnapshot,
  ReminderCapabilityResolver,
  RuntimeReminderConsumeResult,
  RuntimeReminderInput,
  RuntimeReminderProducer,
} from '../reminders'
import { RuntimeReminderScheduler } from '../reminders'
import type { CapabilityValidationFailure } from '../reminders/types'
import { defaultRuntimePromptFeaturePolicy, type RuntimePromptFeaturePolicy } from '../tools'

import type { ToolAllocatorRequest } from './control-plane'
import {
  DefaultRunProfileSelectionId,
  DefaultToolSurfaceProfileId,
} from './RuntimeProfiles'
import { SessionTelemetryCounters } from './SessionTelemetryCounters'

type CodingSessionToolCategoryToolNames = Partial<Record<ToolCategoryId, readonly string[]>>

interface CodingSessionToolContext {
  listTools(scope?: string): Array<{
    name: string
    categoryId?: LooseOptional<ToolCategoryId>
  }>
}

interface CodingSessionTrackerOptions {
  toolCategoryToolNames?: CodingSessionToolCategoryToolNames
  promptFeaturePolicy?: RuntimePromptFeaturePolicy
  thinkingDepth?: ThinkingDepth
  allowedToolCategories?: ToolCategoryId[]
  externalTouchCooldownMs?: number
  normalizeResourceId?: LooseOptional<(raw: string) => LooseOptional<string>>
  toolSurfaceProfile?: ToolSurfaceProfileId
  runProfile?: RunProfileSelectionId
  activeToolCategories?: ToolCategoryId[]
  deniedToolCategories?: readonly ToolCategoryId[]
  residentToolCategories?: readonly ToolCategoryId[]
  toolNameLeaseTurns?: number
  maxTurnPlanningSnapshots?: number
  /** 本次执行当前拥有的互斥能力作用域身份。 */
  activeCapabilityScope?: CapabilityScopeId
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  reminderProducers?: readonly RuntimeReminderProducer[]
  activityCategories?: {
    inspection?: readonly ToolCategoryId[]
    mutation?: readonly ToolCategoryId[]
    validation?: readonly ToolCategoryId[]
    nonCodeMutation?: readonly ToolCategoryId[]
  }
}

function normalizeResourceIdForTracker(raw: string): LooseOptional<string> {
  const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!rel || rel.includes('..')) return null
  return rel
}

/**
 * 编码会话跟踪器：单次智能体执行内的编辑、检查、验证状态机。
 *
 * 主要职责：
 * 1. 用 `editVersion` 标记“当前这一批改动”：每次成功的注入式变更工具调用加一，
 *    随后检查和验证工具会把对应版本推进到当前版本。
 *    当 `editVersion > lastInspectionVersion / lastVerificationVersion` 时，
 *    说明最新一批改动还没有检查或验证过，由此驱动提醒和验证闸门。
 * 2. 跟踪本会话已启用的工具类别、提示能力和会话级授权，
 *    供执行策略、工具注册表和提示段实时读取。
 * 3. 维护工具调用去重、验证指纹去重和
 *    auto-approval notice 一次性消费机制。
 * 4. 把所有信号汇总成 CodingSessionSnapshot，供 prompt 上下文和自动验证 gate 使用。
 *
 * 该实例与一次主 Agent 执行同生命周期；跨 turn 的工具类别授权由
 * AgentRunner.sessionApprovalRegistry 在外层负责恢复/保存。
 */
class CodingSessionTracker {
  private static readonly DefaultToolNameLeaseTurns = 64
  private static readonly DefaultMaxTurnPlanningSnapshots = 8
  private static readonly MaxRecentToolNames = 12
  private static readonly MaxTurnPlanningTelemetryEntries = 8

  /** 当前 mutation 批次版本号；每次成功的 mutation 工具结果 +1。 */
  private editVersion = 0
  /** 已检查（read/list/diff 等）至的编辑版本；用于判断是否需要 inspection reminder。 */
  private lastInspectionVersion = 0
  /** 已验证（project:run / run_verification_plan）至的编辑版本。 */
  private lastVerificationVersion = 0
  /** 已发过 post-edit reminder 的编辑版本；同版本只发一次。 */
  private reminderIssuedForVersion = 0
  /** 已发过 verification reminder（remind 模式）的编辑版本。 */
  private verificationReminderIssuedForVersion = 0
  /** 本会话内是否调用过任何 inspection 工具；用于 preflight reminder 判断。 */
  private hasCapabilityInspection = false
  private readonly modifiedPaths = new Set<string>()
  private latestVerificationStatus: LooseOptional<CapabilityValidationStatus> = null
  private activeVerificationFailure: LooseOptional<CapabilityValidationFailure> = null
  /**
   * 连续 verification 失败次数。
   *
   * 每次 verification 报错 / 超时 +1，成功一次清零。reminder 文案在到达
   * `CodingVerificationConsecutiveFailureEscalationThreshold` 时升级为"建议停下来问用户"。
   */
  private consecutiveVerificationFailures = 0
  private readonly passedVerificationFingerprintsByVersion = new Map<number, Set<string>>()
  private readonly passedVerificationCommandsByVersion = new Map<number, Set<string>>()
  /**
   * 工具运行时使用计数（冷热感知换页用）：每次工具成功执行 +1。
   * 工具换页在触达分区字节预算时，据此优先保留“工作集”（本会话用过的热工具），
   * 淘汰从未被调用的冷工具——类似操作系统按访问频率/近度做页面置换。
   */
  private readonly toolUsageCounts = new Map<string, number>()
  /** 最近使用过的工具名（最新在前、去重、上限 MaxRecentToolNames），供能力扩展过滤上下文噪声。 */
  private readonly recentToolNames: string[] = []
  private readonly telemetryCounters = new SessionTelemetryCounters()
  /**
   * 本轮模型「输入侧真正可用窗口」（`token`），由 `agent loop` 解析模型上下文窗口后写入
   * （见 `SoloLoop`/`QueryLoop` 的 `ContextOS budget governor` / `resolveContextWindowBudget`）。
   * 供编辑工具做「上下文感知的编辑预算」——单次事务 `diff` 预估 `token` 超过可用窗口某比例时强制按文件/按 `hunk` 分批，
   * 避免一个巨型 `diff` 既撑爆上下文又触发反复。未写入时编辑门控退回保守默认窗口。
   */
  private usableContextWindowTokens: Nullable<number> = null
  private readonly enabledToolCategories: Set<ToolCategoryId>
  private readonly activeToolCategories: Set<ToolCategoryId>
  private readonly budgetOverrideToolCategories = new Set<ToolCategoryId>()
  private readonly budgetOverrideToolCategoryTouchedAtTurn = new Map<ToolCategoryId, number>()
  private readonly budgetOverrideToolNames = new Set<string>()
  private readonly budgetOverrideToolNameTouchedAtTurn = new Map<string, number>()
  private readonly toolNameLeaseTurns: number
  private currentToolLeaseTurn = 0
  private readonly turnPlanningSnapshots = new Map<string, unknown>()
  private readonly maxTurnPlanningSnapshots: number
  private lastTurnPlanningTelemetry: LooseOptional<TurnPlanningTelemetryPayload> = null
  private readonly recentTurnPlanningTelemetry: TurnPlanningTelemetryPayload[] = []
  private readonly pendingToolAllocatorRequests: ToolAllocatorRequest[] = []
  private readonly allowedToolCategories: LooseOptional<Set<ToolCategoryId>>
  private readonly deniedToolCategories: ReadonlySet<ToolCategoryId>
  private readonly residentToolCategories: ReadonlySet<ToolCategoryId>
  private readonly enabledPromptFeatures: Set<ChatPromptFeatureId>
  private readonly sessionApprovedToolCategories = new Set<ToolCategoryId>()
  private readonly confirmedRiskScopes = new Set<string>()
  private readonly toolCategoryToolNames: CodingSessionToolCategoryToolNames
  private readonly inspectionTools: Set<string>
  private readonly verificationTools: Set<string>
  private readonly promptFeaturePolicy: RuntimePromptFeaturePolicy
  private activeToolSurfaceProfile: ToolSurfaceProfileId = DefaultToolSurfaceProfileId
  private activeRunProfile: RunProfileSelectionId = DefaultRunProfileSelectionId
  /**
   * 单次 Agent 执行内的能力作用域身份真值。
   *
   * 具体作用域含义由 capability package 定义；追踪器只保存不透明 id。
   */
  private activeCapabilityScope: CapabilityScopeId
  private runProfileRestoreTarget: Nullable<RunProfileSelectionId> = null
  private thinkingDepth: ThinkingDepth
  private readonly externalTouchCooldownMs: number
  private readonly normalizeResourceId: (raw: string) => LooseOptional<string>
  /** auto-approve 时预置的全局一次性 notice，第一个工具调用消费后清空，整会话只展示一次。 */
  private pendingGlobalAutoApprovalNotice: LooseOptional<CapabilityAutoApprovalNotice> = null
  private readonly toolCallDeduper: CodingToolCallDeduper
  private readonly editResultHelper: CodingSessionEditResultHelper
  private readonly verificationHelper: CodingSessionVerificationHelper
  /**
   * 运行时提醒调度器：声明式管理 post-edit / 失败验证等动态提醒。
   */
  private readonly reminderScheduler: RuntimeReminderScheduler
  /**
   * Tool context 解析器：可选注入，提供后用 ToolRegistry 派生可见工具名；
   * 没注入时回退到静态 ToolCategoryToolNames，避免测试场景必须 mock 完整 ToolContext。
   */
  private capabilityToolNamesResolver: ReminderCapabilityResolver
  /** 已绑定的 ToolContext，用于派生 capability resolver；可在 agent loop 启动时通过 attachToolContext 注入。 */
  private boundToolContext: LooseOptional<CodingSessionToolContext> = null

  constructor(
    initialCategories: ToolCategoryId[] = [],
    initialPromptFeatures: ChatPromptFeatureId[] = [...DefaultEnabledPromptFeatures],
    /** 跨 turn 恢复的已批准工具类别，避免每次发消息都重新询问授权。 */
    initialApprovedCategories: ToolCategoryId[] = [],
    /**
     * 本次新增的自动批准类别（区别于跨 turn 恢复）。
     * 这些类别的首次工具调用需要向前端发出 notice 卡片。
     */
    freshAutoApprovedCategories: ToolCategoryId[] = [],
    options: CodingSessionTrackerOptions = {}
  ) {
    this.toolCategoryToolNames = options.toolCategoryToolNames ?? {}
    this.reminderScheduler = new RuntimeReminderScheduler(options.reminderProducers ?? [])
    this.verificationHelper = new CodingSessionVerificationHelper(options.validationInterpreters)
    this.residentToolCategories = new Set(options.residentToolCategories ?? [])
    this.thinkingDepth = options.thinkingDepth ?? 'balanced'
    this.promptFeaturePolicy = options.promptFeaturePolicy ?? defaultRuntimePromptFeaturePolicy
    this.activeToolSurfaceProfile = resolveToolSurfaceProfileId(
      options.toolSurfaceProfile,
      DefaultToolSurfaceProfileId,
      'CodingSessionTracker.toolSurfaceProfile'
    )
    this.activeRunProfile = resolveRunProfileSelectionId(
      options.runProfile,
      DefaultRunProfileSelectionId,
      'CodingSessionTracker.runProfile'
    )
    this.activeCapabilityScope = options.activeCapabilityScope ?? 'default'
    this.toolNameLeaseTurns = Math.max(
      1,
      Math.floor(options.toolNameLeaseTurns ?? CodingSessionTracker.DefaultToolNameLeaseTurns)
    )
    this.maxTurnPlanningSnapshots = Math.max(
      1,
      Math.floor(
        options.maxTurnPlanningSnapshots ??
          CodingSessionTracker.DefaultMaxTurnPlanningSnapshots
      )
    )
    this.allowedToolCategories = options.allowedToolCategories
      ? new Set(options.allowedToolCategories)
      : null
    this.deniedToolCategories = new Set(options.deniedToolCategories ?? [])
    const activityCategories = options.activityCategories ?? {}
    const toolNamesFor = (categories: readonly ToolCategoryId[] = []): string[] =>
      categories.flatMap((categoryId) => this.toolCategoryToolNames[categoryId] ?? [])
    this.inspectionTools = new Set(toolNamesFor(activityCategories.inspection))
    this.verificationTools = new Set(toolNamesFor(activityCategories.validation))
    this.externalTouchCooldownMs =
      options.externalTouchCooldownMs ?? 750
    this.normalizeResourceId =
      options.normalizeResourceId ?? normalizeResourceIdForTracker
    this.editResultHelper = new CodingSessionEditResultHelper({
      mutationToolNames: toolNamesFor(activityCategories.mutation),
      nonCodeMutationToolNames: toolNamesFor(activityCategories.nonCodeMutation),
    })
    this.capabilityToolNamesResolver = (category) => [
      ...(this.toolCategoryToolNames[category] ?? []),
    ]
    this.enabledToolCategories = new Set<ToolCategoryId>(
      initialCategories.filter((categoryId) => this.isToolCategoryAllowed(categoryId))
    )
    this.activeToolCategories = new Set<ToolCategoryId>(
      (options.activeToolCategories ?? [...this.enabledToolCategories]).filter(
        (categoryId) =>
          this.isToolCategoryAllowed(categoryId) && this.enabledToolCategories.has(categoryId)
      )
    )
    this.enabledPromptFeatures = new Set<ChatPromptFeatureId>(
      this.promptFeaturePolicy.normalize(initialPromptFeatures)
    )
    this.promptFeaturePolicy
      .getCategoriesForFeatures(this.getEnabledPromptFeatures())
      .forEach((category) => {
        if (this.isToolCategoryAllowed(category)) {
          this.budgetOverrideToolCategories.add(category)
        }
      })
    for (const category of initialApprovedCategories) {
      if (this.isToolCategoryAllowed(category)) {
        this.sessionApprovedToolCategories.add(category)
        this.budgetOverrideToolCategories.add(category)
      }
    }
    // 为本次新增的 auto-approve 类别预置唯一 notice；整个会话只展示一次，第一个工具调用消费。
    for (const category of freshAutoApprovedCategories) {
      if (this.isToolCategoryAllowed(category)) {
        this.sessionApprovedToolCategories.add(category)
        this.budgetOverrideToolCategories.add(category)
      }
    }
    if (!isEmpty(freshAutoApprovedCategories)) {
      const approvedAt = Date.now()
      this.pendingGlobalAutoApprovalNotice = {
        id: `session-auto-approval:global:${approvedAt}`,
        categories: freshAutoApprovedCategories,
        promptFeatures: [],
        reason: '会话权限已自动批准',
        message: '当前会话权限模式已允许本次能力请求。',
        approvedAt,
      }
    }
    this.toolCallDeduper = new CodingToolCallDeduper({
      getEnabledToolCategories: () => this.enabledToolCategories,
      getEnabledPromptFeatures: () => this.enabledPromptFeatures,
      getSessionApprovedToolCategories: () => this.sessionApprovedToolCategories,
      promptFeaturePolicy: this.promptFeaturePolicy,
    })
  }

  /**
   * 为子 Agent 派生一个隔离的会话追踪器。
   *
   * 复制「配置类」状态（启用/激活的工具类别、prompt 特性、运行策略、profile、
   * 以及当前会话审批的只读快照），但**重置所有易变运行态**：editVersion、
   * modifiedPaths、工具调用去重指纹、验证熔断计数、提醒版本、boundToolContext 等。
   *
   * 这样并发子 Agent 之间、以及子与父之间互不串味——单个子 Agent 的编辑/验证/
   * 去重/审批状态不会污染兄弟或父。持久副作用仍由共享的注入能力服务与
   * WriteLeaseCoordinator 协调，不在此隔离。
   *
   * 子 Agent 对自身追踪器的审批变更不会回灌父的审批集合。
   */
  public forkForSubAgent(): CodingSessionTracker {
    return new CodingSessionTracker(
      [...this.enabledToolCategories],
      [...this.enabledPromptFeatures],
      [...this.sessionApprovedToolCategories],
      [],
      {
        promptFeaturePolicy: this.promptFeaturePolicy,
        toolCategoryToolNames: this.toolCategoryToolNames,
        thinkingDepth: this.thinkingDepth,
        allowedToolCategories: this.allowedToolCategories
          ? [...this.allowedToolCategories]
          : undefined,
        deniedToolCategories: [...this.deniedToolCategories],
        toolSurfaceProfile: this.activeToolSurfaceProfile,
        runProfile: this.activeRunProfile,
        activeToolCategories: [...this.activeToolCategories],
        activeCapabilityScope: this.activeCapabilityScope,
        externalTouchCooldownMs: this.externalTouchCooldownMs,
        normalizeResourceId: this.normalizeResourceId,
      }
    )
  }

  private readonly recentFileChanges: Array<{
    toolName: string
    path: string
    created: boolean
    added: number
    removed: number
    changeId: string
  }> = []

  /** 本会话内各路径的最新 snapshot.revision（read / apply 结果刷新）。 */
  private readonly resourceRevisionById = new Map<string, string>()
  /** 宿主或外部编辑器触发、等待 sanitize 标记 stale read 的资源路径。 */
  private readonly externallyTouchedPaths = new Set<string>()
  private kernelMutationCooldownUntil = 0

  /** 从工具结果中提取 fileChanges 描述符并追加到 recentFileChanges。 */
  private collectFileChanges(toolName: string, result: unknown): void {
    if (!result || !isObject(result)) return
    const record = result as Record<string, unknown>
    const raw = record['fileChanges']
    if (!isArray(raw)) return
    for (const item of raw) {
      if (!item || !isObject(item)) continue
      const change = item as Record<string, unknown>
      if (!isString(change['changeId']) || !isString(change['path'])) continue
      this.recentFileChanges.push({
        toolName,
        path: change['path'],
        created: isTrue(change['created']),
        added: isNumber(change['added']) ? change['added'] : 0,
        removed: isNumber(change['removed']) ? change['removed'] : 0,
        changeId: change['changeId'],
      })
    }
    // 只保留最近 60 条，避免长会话无限膨胀
    if (this.recentFileChanges.length > 60) {
      this.recentFileChanges.splice(0, this.recentFileChanges.length - 60)
    }
  }

  /**
   * 合并路径→revision（apply_edit.newRevisions 与 project:read 快照），
   * 供模型历史清洗阶段丢弃过期读结果。
   */
  private mergeResourceRevisionHints(toolName: string, result: unknown): void {
    if (!result || !isObject(result)) return
    const record = result as Record<string, unknown>

    const nr = record['newRevisions']
    if (isPlainObject(nr)) {
      for (const [path, rev] of Object.entries(nr)) {
        if (!isString(path) || !isString(rev)) continue
        if (rev === 'deleted') {
          this.resourceRevisionById.delete(path)
          this.externallyTouchedPaths.delete(path)
        } else {
          this.resourceRevisionById.set(path, rev)
          this.externallyTouchedPaths.delete(path)
        }
      }
    }

    const snapSingle = record['snapshot']
    if (snapSingle && isObject(snapSingle)) {
      const s = snapSingle as Record<string, unknown>
      if (isString(s.path) && isString(s.revision)) {
        this.resourceRevisionById.set(s.path, s.revision)
        this.externallyTouchedPaths.delete(s.path)
      }
    }

    const files = record['files']
    if (isArray(files)) {
      for (const item of files) {
        if (!item || !isObject(item)) continue
        const snap = (item as Record<string, unknown>).snapshot
        if (!snap || !isObject(snap)) continue
        const s = snap as Record<string, unknown>
        if (isString(s.path) && isString(s.revision)) {
          this.resourceRevisionById.set(s.path, s.revision)
          this.externallyTouchedPaths.delete(s.path)
        }
      }
    }

  }

  /** 返回会话内已知的最新内核 revision（路径 → revision）。 */
  public getResourceRevisionHints(): Record<string, string> {
    return Object.fromEntries(this.resourceRevisionById)
  }

  public getExternallyTouchedResourceIds(): readonly string[] {
    return [...this.externallyTouchedPaths]
  }

  /**
   * 从上一轮 turn 结束时 push 到宿主资源真值注册表的快照，把
   * revision map / external touch 集合灌进新 tracker。
   *
   * 用途：每次主 Agent 执行都会 new 一个 tracker，导致 turn-2 头部第一次
   * sanitize 时拿不到 turn-1 已经把文件推进的事实——history 里 turn-1 的 read
   * 结果（rev-1）原样进入 model context，模型可能误以为是最新，直接拿 rev-1
   * 当 baseRevision 调 prepare_edit → 在 kernel 那儿撞 BASE_REVISION_MISMATCH
   * 才被动反弹，浪费一整次工具往返。
   *
   * seed 不是真值的最终来源——turn 内任何成功的 read / apply 都会通过
   * `mergeResourceRevisionHints` 继续推进；fs.watch 推过来的 external touch
   * 也仍然走 `notifyExternalFilesystemTouches`。seed 只提供"起点"。
   *
   * 多次调用会以"覆盖且不清空既有"为准——seed 是补字典，不是替换。这一点
   * 与 mergeSnapshot（按字段聚合）有意保持一致：seed 仅在 tracker 完全新建
   * 时调用一次，没有"reset 再 seed"的语义。
   */
  public seedResourceTruth(snapshot: {
    revisionsByResource?: Readonly<Record<string, string>>
    externallyTouchedResourceIds?: readonly string[]
  }): void {
    const { revisionsByResource, externallyTouchedResourceIds } = snapshot
    if (revisionsByResource) {
      for (const [path, revision] of Object.entries(revisionsByResource)) {
        if (!isString(path) || !isString(revision)) continue
        if (!path || !revision) continue
        // seed 期间不动 deduper 的失败记录——tracker 刚建好还没有任何记录，
        // 这里直接写 map 即可，避免无谓 dedupe 副作用。
        this.resourceRevisionById.set(path, revision)
      }
    }
    if (externallyTouchedResourceIds) {
      for (const raw of externallyTouchedResourceIds) {
        const rel = this.normalizeResourceId(raw)
        if (!rel) continue
        // 上轮 turn 结束时挂的外部 touch 仍然有效——模型在 turn-2 看到对应路径
        // 的 read 结果时，sanitize 才能正确重写成 stale 占位。
        this.externallyTouchedPaths.add(rel)
      }
    }
  }

  /**
   * 把 fs.watch 收集到的外部文件系统 touch 灌进会话级"外部触碰集合"，
   * 后续 sanitize 会用它把对应路径的 read 重写成 stale 占位。
   *
   * 边界 case 说明：成功的注入式 editing capability 会触发宿主进程自己的写盘，
   * 资源观察器会把这次写盘当成"外部 touch"回声送进来。为了避免把能力自身
   * 的写入误标为外部修改、进而把刚刚返回 fresh revision 的那条 read 重写成 stale，
   * 这里在 mutation cooldown 期内一律丢弃推入。
   *
   * 已知短板：cooldown 之内的"真·外部写入"（用户在外部编辑器手动改文件，
   * 时间窗刚好跟一次 apply_edit 重合）也会被一并丢弃。这是 best-effort 取舍：
   *  - cooldown 之外、下一轮 sanitize 时会自然捕获到（fs.watch 仍在监听）；
   *  - 模型若紧接着调用变更能力，能力实现的 revision mismatch 校验是硬保底；
   * 因此该缝隙不会破坏数据完整性，只是 stale 提示可能晚一轮才生效。
   */
  public notifyExternalFilesystemTouches(relativePaths: readonly string[]): void {
    if (Date.now() < this.kernelMutationCooldownUntil) return

    let recordedExternalMutation = false
    for (const raw of relativePaths) {
      const rel = this.normalizeResourceId(raw)
      if (!rel) continue
      if (this.externallyTouchedPaths.has(rel)) continue
      this.externallyTouchedPaths.add(rel)
      this.modifiedPaths.add(rel)
      recordedExternalMutation = true
    }

    if (recordedExternalMutation) {
      this.editVersion += 1
      this.resetVerificationStateForEdits()
    }
  }

  /** 返回本会话内所有已记录的文件变更，供 get_session_edit_log 使用。 */
  public getRecentFileChanges() {
    return [...this.recentFileChanges]
  }

  /** 最近使用过的工具名（最新在前、去重），供能力扩展过滤相关上下文噪声。 */
  public getRecentToolNames(): string[] {
    return [...this.recentToolNames]
  }

  private trackRecentToolName(toolName: string): void {
    const existingIndex = this.recentToolNames.indexOf(toolName)
    if (existingIndex >= 0) {
      this.recentToolNames.splice(existingIndex, 1)
    }
    this.recentToolNames.unshift(toolName)
    if (this.recentToolNames.length > CodingSessionTracker.MaxRecentToolNames) {
      this.recentToolNames.length = CodingSessionTracker.MaxRecentToolNames
    }
  }

  public recordToolResult(toolName: string, result: unknown): void {
    // 工作集计数：无论结果是否“有效编辑”，工具被实际调用就记一次热度。
    this.toolUsageCounts.set(toolName, (this.toolUsageCounts.get(toolName) ?? 0) + 1)
    this.trackRecentToolName(toolName)
    if (this.budgetOverrideToolNames.has(toolName)) {
      this.budgetOverrideToolNameTouchedAtTurn.set(toolName, this.currentToolLeaseTurn)
    }
    const toolCategory = this.resolveToolCategoryForToolName(toolName)
    if (toolCategory && this.budgetOverrideToolCategories.has(toolCategory)) {
      this.budgetOverrideToolCategoryTouchedAtTurn.set(toolCategory, this.currentToolLeaseTurn)
    }

    if (this.editResultHelper.isSkippedOrUnchangedResult(result)) return

    if (this.editResultHelper.isNonCodeArtifactMutation(toolName, result)) return

    this.mergeResourceRevisionHints(toolName, result)

    if (this.editResultHelper.isCapabilityMutationTool(toolName)) {
      this.kernelMutationCooldownUntil = Date.now() + this.externalTouchCooldownMs
      this.editVersion += 1
      this.resetVerificationStateForEdits()
      this.collectModifiedPaths(result)
      this.collectFileChanges(toolName, result)
      return
    }

    if (this.inspectionTools.has(toolName)) {
      this.hasCapabilityInspection = true
    }

    if (this.editVersion === 0) return

    if (this.inspectionTools.has(toolName)) {
      this.lastInspectionVersion = this.editVersion
      return
    }

    if (this.verificationTools.has(toolName)) {
      this.lastVerificationVersion = this.editVersion
      this.collectVerificationNotes(toolName, result)
    }
  }

  public recordToolCallResult(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown
  ): void {
    if (toolName === 'tooling:replace') {
      this.telemetryCounters.recordToolReplaceCall()
    }
    this.toolCallDeduper.recordIdempotentToolCall(toolName, args)
    const fingerprint = this.buildVerificationToolFingerprint(toolName, args)
    if (!fingerprint || !this.isPassedVerificationResult(toolName, result)) return

    this.getPassedVerificationFingerprintsForCurrentVersion().add(fingerprint)
    this.recordPassedVerificationCommandForCurrentVersion(toolName, args)
  }

  public getRedundantToolCallMessage(
    toolName: string,
    args: Record<string, unknown>
  ): Nullable<string> {
    const redundantPromptFeatureMessage = this.toolCallDeduper.getRedundantPromptFeatureMessage(
      toolName,
      args
    )
    if (redundantPromptFeatureMessage) return this.recordDedupeHit(redundantPromptFeatureMessage)

    const repeatedIdempotentMessage = this.toolCallDeduper.getRepeatedIdempotentToolCallMessage(
      toolName,
      args
    )
    if (repeatedIdempotentMessage) return this.recordDedupeHit(repeatedIdempotentMessage)

    const fingerprint = this.buildVerificationToolFingerprint(toolName, args)
    if (!fingerprint) return null

    if (isTrue(args.allowRepeat)) return null

    if (
      !this.getPassedVerificationFingerprintsForCurrentVersion().has(fingerprint) &&
      !this.hasPassedVerificationCommandForCurrentVersion(args.command)
    ) return null

    return this.recordDedupeHit([
      '已拦截重复验证：同一轮改动后已经成功运行过相同的验证步骤。',
      '不要再次运行同一个验证命令；请改为检查 diff/变更文件，或者直接总结当前结果、验证状态和剩余风险。',
      '只有在新增编辑、验证失败被修复、或用户明确要求重复验证时，才需要重新运行。',
    ].join('\n'))
  }

  private recordDedupeHit(message: string): string {
    this.telemetryCounters.recordDedupeHit()
    return message
  }

  public finalizeReminderConsumeResult(result: LooseOptional<RuntimeReminderConsumeResult>): void {
    if (!result) return

    void result.producerId
  }

  /** 允许 agent loop 启动时把 ToolContext 绑入 tracker，用于派生当前可见工具名。 */
  public attachToolContext(toolContext: CodingSessionToolContext): void {
    this.boundToolContext = toolContext
    this.capabilityToolNamesResolver = (category) => {
      // 优先用 ToolContext.listTools('all') —— 反映本运行时真实可见的工具集合。
      const visible = toolContext
        .listTools('all')
        .filter((tool) => tool.categoryId === category)
        .map((tool) => tool.name)
      if (!isEmpty(visible)) return visible
      // 回退：static catalog；保证测试/早期 boot 阶段也能渲染。
      return [...(this.toolCategoryToolNames[category] ?? [])]
    }
  }

  /** 给外部（如自动验证 helper）直接访问 scheduler 的能力，方便复用 producer。 */
  public getReminderScheduler(): RuntimeReminderScheduler {
    return this.reminderScheduler
  }

  /** 构建调度器输入：把当前 snapshot / editVersion / 工具名解析器打包给 producer。 */
  public buildReminderInput(): RuntimeReminderInput {
    return {
      toolContext: this.boundToolContext,
      snapshot: this.getSnapshot(),
      enabledToolCategories: this.getEnabledToolCategories(),
      editVersion: this.editVersion,
      thinkingDepth: this.thinkingDepth,
      capabilityToolNames: this.capabilityToolNamesResolver,
    }
  }

  public recordVerificationReminderIssued(): void {
    if (this.editVersion > 0) {
      this.verificationReminderIssuedForVersion = this.editVersion
    }
  }

  public recordVerificationPlanResult(
    toolName: string,
    result: CapabilityValidationRunResult
  ): void {
    if (this.editVersion > 0) {
      this.lastVerificationVersion = this.editVersion
    }

    this.collectVerificationNotes(toolName, result)
  }

  public recordVerificationFailure(
    command: string,
    status: Extract<CapabilityValidationStatus, 'failed' | 'timed-out'>,
    issues: string[]
  ): void {
    if (this.editVersion > 0) {
      this.lastVerificationVersion = this.editVersion
    }

    this.latestVerificationStatus = status
    this.activeVerificationFailure = {
      command,
      status,
      issues: issues.slice(0, 5),
    }
    this.consecutiveVerificationFailures += 1
  }

  public getSnapshot(): CodingSessionSnapshot {
    return {
      modifiedPaths: Array.from(this.modifiedPaths),
      hasCapabilityMutations: this.editVersion > 0,
      hasCapabilityInspection: this.hasCapabilityInspection,
      needsChangeInspection: this.editVersion > this.lastInspectionVersion,
      needsVerificationCommand: this.editVersion > this.lastVerificationVersion,
      reminderIssuedForCurrentEdits: this.reminderIssuedForVersion === this.editVersion,
      verificationReminderIssuedForCurrentEdits:
        this.verificationReminderIssuedForVersion === this.editVersion,
      latestVerificationStatus: toNullable(this.latestVerificationStatus),
      activeVerificationFailure: toNullable(this.activeVerificationFailure),
      consecutiveVerificationFailures: this.consecutiveVerificationFailures,
    }
  }

  public mergeSnapshot(snapshot: CodingSessionSnapshot): void {
    snapshot.modifiedPaths.forEach((path) => {
      this.modifiedPaths.add(path)
    })

    if (snapshot.hasCapabilityInspection) {
      this.hasCapabilityInspection = true
    }

    if (snapshot.hasCapabilityMutations) {
      this.editVersion += 1
      if (!snapshot.needsChangeInspection) {
        this.lastInspectionVersion = this.editVersion
      }
      if (!snapshot.needsVerificationCommand) {
        this.lastVerificationVersion = this.editVersion
      }
      if (snapshot.reminderIssuedForCurrentEdits) {
        this.reminderIssuedForVersion = this.editVersion
      }
      if (snapshot.verificationReminderIssuedForCurrentEdits) {
        this.verificationReminderIssuedForVersion = this.editVersion
      }
    }

    if (snapshot.latestVerificationStatus) {
      this.latestVerificationStatus = snapshot.latestVerificationStatus
    }

    if (snapshot.activeVerificationFailure) {
      this.activeVerificationFailure = {
        command: snapshot.activeVerificationFailure.command,
        status: snapshot.activeVerificationFailure.status,
        issues: [...snapshot.activeVerificationFailure.issues],
      }
    }

    if (
      isNumber(snapshot.consecutiveVerificationFailures) &&
      snapshot.consecutiveVerificationFailures > this.consecutiveVerificationFailures
    ) {
      this.consecutiveVerificationFailures = snapshot.consecutiveVerificationFailures
    }
  }

  public enableToolCategories(categories: ToolCategoryId[], _reason?: string): ToolCategoryId[] {
    const dynamicLease = this.shouldTrackDynamicToolCategoryLease(_reason)
    categories.forEach((categoryId) => {
      if (!this.isToolCategoryAllowed(categoryId)) return
      this.enabledToolCategories.add(categoryId)
      this.activeToolCategories.add(categoryId)
      if (dynamicLease && !this.residentToolCategories.has(categoryId)) {
        this.budgetOverrideToolCategories.add(categoryId)
        this.budgetOverrideToolCategoryTouchedAtTurn.set(
          categoryId,
          this.currentToolLeaseTurn
        )
      }
    })

    return this.getEnabledToolCategories()
  }

  public disableToolCategories(categories: ToolCategoryId[], _reason?: string): ToolCategoryId[] {
    return this.disableToolCategoriesInternal(categories)
  }

  private disableToolCategoriesInternal(
    categories: ToolCategoryId[],
    options: { preserveSessionApprovals?: boolean } = {}
  ): ToolCategoryId[] {
    const protectedIds = this.residentToolCategories
    for (const categoryId of categories) {
      if (protectedIds.has(categoryId)) {
        continue
      }
      this.enabledToolCategories.delete(categoryId)
      this.activeToolCategories.delete(categoryId)
      if (!options.preserveSessionApprovals) {
        this.sessionApprovedToolCategories.delete(categoryId)
      }
      this.budgetOverrideToolCategories.delete(categoryId)
      this.budgetOverrideToolCategoryTouchedAtTurn.delete(categoryId)
      this.toolCategoryToolNames[categoryId]?.forEach((toolName) => {
        this.budgetOverrideToolNames.delete(toolName)
        this.budgetOverrideToolNameTouchedAtTurn.delete(toolName)
      })
    }

    return this.getEnabledToolCategories()
  }

  public enableToolNames(toolNames: string[], _reason?: string): string[] {
    toolNames.forEach((toolName) => {
      const normalized = toolName.trim()
      if (normalized) {
        this.budgetOverrideToolNames.add(normalized)
        this.budgetOverrideToolNameTouchedAtTurn.set(normalized, this.currentToolLeaseTurn)
      }
    })

    return this.getBudgetOverrideToolNames()
  }

  public disableToolNames(toolNames: string[], _reason?: string): string[] {
    toolNames.forEach((toolName) => {
      const normalized = toolName.trim()
      if (normalized) {
        this.budgetOverrideToolNames.delete(normalized)
        this.budgetOverrideToolNameTouchedAtTurn.delete(normalized)
        this.reportedEvictedPageInTools.delete(normalized)
      }
    })

    return this.getBudgetOverrideToolNames()
  }

  public pruneExpiredToolNameLeases(turn: number): string[] {
    const normalizedTurn = isFiniteNumber(turn) ? Math.max(0, Math.floor(turn)) : 0
    this.currentToolLeaseTurn = normalizedTurn
    const expired: string[] = []

    for (const toolName of [...this.budgetOverrideToolNames]) {
      const touchedTurn = this.budgetOverrideToolNameTouchedAtTurn.get(toolName)
      if (!isFiniteNumber(touchedTurn)) {
        this.budgetOverrideToolNameTouchedAtTurn.set(toolName, normalizedTurn)
        continue
      }

      if (normalizedTurn - touchedTurn < this.toolNameLeaseTurns) {
        continue
      }

      this.budgetOverrideToolNames.delete(toolName)
      this.budgetOverrideToolNameTouchedAtTurn.delete(toolName)
      this.reportedEvictedPageInTools.delete(toolName)
      expired.push(toolName)
    }

    return expired
  }

  public pruneExpiredToolCategoryLeases(turn: number): ToolCategoryId[] {
    const normalizedTurn = isFiniteNumber(turn) ? Math.max(0, Math.floor(turn)) : 0
    this.currentToolLeaseTurn = normalizedTurn
    const protectedIds = this.residentToolCategories
    const expired: ToolCategoryId[] = []

    for (const categoryId of [...this.budgetOverrideToolCategories]) {
      if (protectedIds.has(categoryId)) {
        this.budgetOverrideToolCategories.delete(categoryId)
        this.budgetOverrideToolCategoryTouchedAtTurn.delete(categoryId)
        continue
      }

      const touchedTurn = this.budgetOverrideToolCategoryTouchedAtTurn.get(categoryId)
      if (!isFiniteNumber(touchedTurn)) {
        this.budgetOverrideToolCategoryTouchedAtTurn.set(categoryId, normalizedTurn)
        continue
      }

      if (normalizedTurn - touchedTurn < this.toolNameLeaseTurns) continue

      this.enabledToolCategories.delete(categoryId)
      this.activeToolCategories.delete(categoryId)
      this.budgetOverrideToolCategories.delete(categoryId)
      this.budgetOverrideToolCategoryTouchedAtTurn.delete(categoryId)
      this.toolCategoryToolNames[categoryId]?.forEach((toolName) => {
        this.budgetOverrideToolNames.delete(toolName)
        this.budgetOverrideToolNameTouchedAtTurn.delete(toolName)
        this.reportedEvictedPageInTools.delete(toolName)
      })
      expired.push(categoryId)
    }

    return expired
  }

  private shouldTrackDynamicToolCategoryLease(reason?: string): boolean {
    const normalized = reason?.trim()
    if (!normalized) return false
    return !normalized.toLowerCase().startsWith('run profile ')
  }

  private resolveToolCategoryForToolName(toolName: string): LooseOptional<ToolCategoryId> {
    const runtimeTool = this.boundToolContext
      ?.listTools('all')
      .find((tool) => tool.name === toolName && isPresent(tool.categoryId))
    if (runtimeTool?.categoryId) return runtimeTool.categoryId

    for (const [categoryId, toolNames] of Object.entries(this.toolCategoryToolNames) as Array<
      [ToolCategoryId, readonly string[]]
    >) {
      if (toolNames.includes(toolName)) return categoryId
    }

    return null
  }

  public getTurnPlanningSnapshot<TSnapshot = unknown>(signature: string): Nullable<TSnapshot> {
    if (!signature) return null
    if (!this.turnPlanningSnapshots.has(signature)) return null
    const snapshot = this.turnPlanningSnapshots.get(signature) as TSnapshot
    this.turnPlanningSnapshots.delete(signature)
    this.turnPlanningSnapshots.set(signature, snapshot)
    return snapshot
  }

  public setTurnPlanningSnapshot(signature: string, snapshot: unknown): void {
    if (!signature) return
    if (this.turnPlanningSnapshots.has(signature)) {
      this.turnPlanningSnapshots.delete(signature)
    }
    this.turnPlanningSnapshots.set(signature, snapshot)
    while (this.turnPlanningSnapshots.size > this.maxTurnPlanningSnapshots) {
      const oldest = this.turnPlanningSnapshots.keys().next().value
      if (!isString(oldest)) break
      this.turnPlanningSnapshots.delete(oldest)
    }
  }

  public recordTurnPlanningTelemetry(entry: TurnPlanningTelemetryPayload): void {
    const snapshot = {
      ...entry,
      expiredToolNameLeases: [...entry.expiredToolNameLeases],
      categorySummary: entry.categorySummary.map((category) => ({
        id: category.id,
        toolCount: category.toolCount,
      })),
    }
    this.lastTurnPlanningTelemetry = snapshot
    this.recentTurnPlanningTelemetry.push(snapshot)
    while (
      this.recentTurnPlanningTelemetry.length >
      CodingSessionTracker.MaxTurnPlanningTelemetryEntries
    ) {
      this.recentTurnPlanningTelemetry.shift()
    }
  }

  public getLastTurnPlanningTelemetry(): Nullable<TurnPlanningTelemetryPayload> {
    return this.lastTurnPlanningTelemetry
      ? {
          ...this.lastTurnPlanningTelemetry,
          expiredToolNameLeases: [...this.lastTurnPlanningTelemetry.expiredToolNameLeases],
          categorySummary: this.lastTurnPlanningTelemetry.categorySummary.map((category) => ({
            id: category.id,
            toolCount: category.toolCount,
          })),
        }
      : null
  }

  public getToolSchemaBudgetScale(): number {
    let consecutivePressureTurns = 0

    for (let index = this.recentTurnPlanningTelemetry.length - 1; index >= 0; index -= 1) {
      const entry = this.recentTurnPlanningTelemetry[index]
      if (!entry || entry.droppedToolCount <= 0) break
      consecutivePressureTurns += 1
    }

    if (consecutivePressureTurns >= 4) return 0.7
    if (consecutivePressureTurns >= 2) return 0.85
    return 1
  }

  public enqueueToolAllocatorRequest(request: ToolAllocatorRequest): number {
    this.pendingToolAllocatorRequests.push({
      ...request,
      operations: [...request.operations],
      targets: request.targets ? [...request.targets] : undefined,
    })
    return this.pendingToolAllocatorRequests.length
  }

  public drainToolAllocatorRequests(): ToolAllocatorRequest[] {
    const drained = this.pendingToolAllocatorRequests.splice(0)
    return drained.map((request) => ({
      ...request,
      operations: [...request.operations],
      targets: request.targets ? [...request.targets] : undefined,
    }))
  }

  /** 已就“缺页（被预算换出）”上报过的 page-in 工具名，避免每轮重复刷屏。 */
  private readonly reportedEvictedPageInTools = new Set<string>()

  /**
   * 计算本轮“新发生缺页”的 page-in 工具并标记已上报。
   *
   * 背景：模型 tooling:replace page-in 的工具进入 budgetOverrideToolNames 获得驻留优先级，
   * 但动态工具空间是硬预算——当驻留集合本身超出 maxToolSchemaChars 时，部分 page-in 工具仍会被换出。
   * 若对模型静默，模型会困惑“为什么换入的工具下一轮不见了”。这里把换出的 page-in 工具回报给上层，
   * 由 agent loop 注入一条 system 提醒。
   *
   * 去重策略：已上报过的不再重复；一旦某工具重新回到驻留集合（不在 evicted 列表里），
   * 清除其记录，使它将来再次被换出时能重新上报。
   */
  public collectNewlyEvictedPagedInTools(evictedToolNames: readonly string[]): string[] {
    const evicted = new Set(evictedToolNames)
    for (const name of [...this.reportedEvictedPageInTools]) {
      if (!evicted.has(name)) {
        this.reportedEvictedPageInTools.delete(name)
      }
    }

    const newly: string[] = []
    for (const name of evictedToolNames) {
      if (!this.reportedEvictedPageInTools.has(name)) {
        this.reportedEvictedPageInTools.add(name)
        newly.push(name)
      }
    }

    return newly
  }

  public hasToolCategoryAccess(category: ToolCategoryId): boolean {
    return this.enabledToolCategories.has(category)
  }

  public hasActiveToolCategoryAccess(category: ToolCategoryId): boolean {
    return this.activeToolCategories.has(category)
  }

  public isToolCategoryAllowed(category: ToolCategoryId): boolean {
    if (this.deniedToolCategories.has(category)) return false
    return !(this.allowedToolCategories && !this.allowedToolCategories.has(category))
  }

  public getEnabledToolCategories(): ToolCategoryId[] {
    return [...this.enabledToolCategories]
  }

  public getActiveToolCategories(): ToolCategoryId[] {
    return [...this.activeToolCategories]
  }

  /** Read the opaque capability scope selected by the composition root. */
  public getActiveCapabilityScope(): CapabilityScopeId {
    return this.activeCapabilityScope
  }

  public getToolSurfaceProfile(): ToolSurfaceProfileId {
    return this.activeToolSurfaceProfile
  }

  public setThinkingDepth(thinkingDepth: ThinkingDepth): ThinkingDepth {
    this.thinkingDepth = thinkingDepth
    return this.thinkingDepth
  }

  public setToolSurfaceProfile(
    profile: ToolSurfaceProfileId,
    _reason?: string
  ): ToolSurfaceProfileId {
    this.activeToolSurfaceProfile = assertToolSurfaceProfileId(
      profile,
      'CodingSessionTracker.toolSurfaceProfile'
    )
    return this.activeToolSurfaceProfile
  }

  public getRunProfile(): RunProfileSelectionId {
    return this.activeRunProfile
  }

  public getRunProfileRestoreTarget(): Nullable<RunProfileSelectionId> {
    return this.runProfileRestoreTarget
  }

  public setRunProfileRestoreTarget(
    profile: Nullable<RunProfileSelectionId>
  ): Nullable<RunProfileSelectionId> {
    this.runProfileRestoreTarget = profile
      ? assertRunProfileSelectionId(profile, 'CodingSessionTracker.runProfileRestoreTarget')
      : null
    return this.runProfileRestoreTarget
  }

  public getBudgetOverrideToolCategories(): ToolCategoryId[] {
    return [...this.budgetOverrideToolCategories]
  }

  public getBudgetOverrideToolNames(): string[] {
    return [...this.budgetOverrideToolNames]
  }

  /** 工具运行时使用计数快照（冷热感知换页用，值为本会话累计调用次数）。 */
  public getToolUsageScores(): Record<string, number> {
    return Object.fromEntries(this.toolUsageCounts)
  }

  public recordInvisibleToolCall(_toolName: string): void {
    this.telemetryCounters.recordInvisibleToolCall()
  }

  public recordConfirmationCard(): void {
    this.telemetryCounters.recordConfirmationCard()
  }

  public grantConfirmedRiskScope(scope: string, _reason?: string): string[] {
    const normalizedScope = scope.trim()
    if (!normalizedScope) return this.getConfirmedRiskScopes()

    this.confirmedRiskScopes.add(normalizedScope)
    return this.getConfirmedRiskScopes()
  }

  public hasConfirmedRiskScope(scope: string): boolean {
    const normalizedScope = scope.trim()
    return !!normalizedScope && this.confirmedRiskScopes.has(normalizedScope)
  }

  public getConfirmedRiskScopes(): string[] {
    return [...this.confirmedRiskScopes]
  }

  public getToolLayerTelemetryMetrics(turnsPerCompletedTask?: number): ToolLayerTelemetryMetrics {
    return {
      enableToolsPerSession: this.telemetryCounters.enableToolsPerSession,
      dedupeHitCount: this.telemetryCounters.dedupeHitCount,
      invisibleToolCallCount: this.telemetryCounters.invisibleToolCallCount,
      confirmCardsPerSession: this.telemetryCounters.confirmCardsPerSession,
      toolsBlockCacheInvalidationRate: this.getToolsBlockCacheInvalidationRate(),
      turnsPerCompletedTask: isFiniteNumber(turnsPerCompletedTask)
        ? Math.max(0, Math.floor(turnsPerCompletedTask))
        : null,
    }
  }

  private getToolsBlockCacheInvalidationRate(): Nullable<number> {
    if (this.recentTurnPlanningTelemetry.length < 2) return null

    let transitions = 0
    let changed = 0
    for (let index = 1; index < this.recentTurnPlanningTelemetry.length; index += 1) {
      const previous = this.recentTurnPlanningTelemetry[index - 1]
      const current = this.recentTurnPlanningTelemetry[index]
      if (!previous || !current) continue
      transitions += 1
      if (previous.signature !== current.signature) changed += 1
    }

    if (transitions === 0) return null
    return Math.round((changed / transitions) * 1000) / 1000
  }

  /** agent loop 每轮解析出模型可用窗口（token）后写入，供编辑预算门控读取；传非正数视为未知。 */
  public setUsableContextWindowTokens(tokens: Nullable<number>): void {
    this.usableContextWindowTokens = isPositiveNumber(tokens) ? Math.floor(tokens) : null
  }

  /** 读取本轮模型输入侧可用窗口（token）；未知时为 null，调用方应退回保守默认。 */
  public getUsableContextWindowTokens(): Nullable<number> {
    return this.usableContextWindowTokens
  }

  public setRunProfile(profile: RunProfileSelectionId, _reason?: string): RunProfileSelectionId {
    this.activeRunProfile = assertRunProfileSelectionId(profile, 'CodingSessionTracker.runProfile')
    return this.activeRunProfile
  }

  public grantSessionToolCategoryApproval(
    category: ToolCategoryId,
    _reason?: string
  ): ToolCategoryId[] {
    if (!this.isToolCategoryAllowed(category)) return this.getSessionApprovedToolCategories()
    this.sessionApprovedToolCategories.add(category)
    return this.getSessionApprovedToolCategories()
  }

  public hasSessionToolCategoryApproval(category: ToolCategoryId): boolean {
    return this.sessionApprovedToolCategories.has(category)
  }

  public getSessionApprovedToolCategories(): ToolCategoryId[] {
    return [...this.sessionApprovedToolCategories]
  }

  /**
   * 消费全局 auto-approve notice（忽略 category 参数，兼容现有调用签名）。
   * 整会话只消费一次。
   */
  public consumePendingAutoApprovalNotice(
    _category: ToolCategoryId
  ): Nullable<CapabilityAutoApprovalNotice> {
    const notice = toNullable(this.pendingGlobalAutoApprovalNotice)
    if (notice) {
      this.pendingGlobalAutoApprovalNotice = null
    }
    return notice
  }

  public enablePromptFeatures(
    features: ChatPromptFeatureId[],
    _reason?: string
  ): ChatPromptFeatureId[] {
    const normalizedFeatures = this.promptFeaturePolicy.normalize(features)
    normalizedFeatures.forEach((feature) => {
      this.enabledPromptFeatures.add(feature)
    })
    this.promptFeaturePolicy.getCategoriesForFeatures(normalizedFeatures).forEach((category) => {
      if (this.isToolCategoryAllowed(category)) {
        this.budgetOverrideToolCategories.add(category)
      }
    })

    return this.getEnabledPromptFeatures()
  }

  public disablePromptFeatures(
    features: ChatPromptFeatureId[],
    _reason?: string
  ): ChatPromptFeatureId[] {
    this.promptFeaturePolicy.normalize(features).forEach((feature) => {
      this.enabledPromptFeatures.delete(feature)
      if (feature === 'office') {
        this.sessionApprovedToolCategories.delete('office')
      }
    })
    const remainingPromptFeatureCategories = new Set(
      this.promptFeaturePolicy.getCategoriesForFeatures(this.getEnabledPromptFeatures())
    )
    this.promptFeaturePolicy.getCategoriesForFeatures(features).forEach((category) => {
      if (!remainingPromptFeatureCategories.has(category)) {
        this.budgetOverrideToolCategories.delete(category)
      }
    })

    return this.getEnabledPromptFeatures()
  }

  public hasPromptFeatureAccess(feature: ChatPromptFeatureId): boolean {
    return this.enabledPromptFeatures.has(feature)
  }

  public getEnabledPromptFeatures(): ChatPromptFeatureId[] {
    return [...this.enabledPromptFeatures]
  }

  private resetVerificationStateForEdits(): void {
    this.latestVerificationStatus = null
    this.activeVerificationFailure = null
  }

  private collectModifiedPaths(result: unknown): void {
    this.editResultHelper.extractModifiedPaths(result).forEach((path) => {
      this.modifiedPaths.add(path)
    })
  }

  private collectVerificationNotes(toolName: string, result: unknown): void {
    const verification = this.verificationHelper.collectVerificationToolResult(toolName, result)
    if (!verification) return

    this.applyVerificationCollectionResult(verification)
  }

  /**
   * 把 verification helper 抽出来的结果灌进会话状态——同时维护"连续失败计数"。
   *
   * 命中失败 / timed-out → +1；命中 passed → 清零。其它状态（unknown）保持不变，
   * 避免不明确的状态把计数器误重置。
   */
  private applyVerificationCollectionResult(verification: {
    latestVerificationStatus: LooseOptional<CapabilityValidationStatus>
    activeVerificationFailure: LooseOptional<CapabilityValidationFailure>
  }): void {
    this.latestVerificationStatus = verification.latestVerificationStatus
    this.activeVerificationFailure = verification.activeVerificationFailure
    if (verification.latestVerificationStatus === 'passed') {
      this.consecutiveVerificationFailures = 0
    } else if (
      verification.latestVerificationStatus === 'failed' ||
      verification.latestVerificationStatus === 'timed-out'
    ) {
      this.consecutiveVerificationFailures += 1
    }
  }

  private getPassedVerificationFingerprintsForCurrentVersion(): Set<string> {
    const existing = this.passedVerificationFingerprintsByVersion.get(this.editVersion)
    if (existing) return existing

    // editVersion 持续递增，老 version 上挂的 fingerprint Set 不再被读到（recordToolResult
    // 只会写当前 editVersion）。这里在新建一条桶位时做一次 LRU 清理：只保留最近若干个
    // editVersion 的 fingerprints，防止长时段 session 里 Map 无限膨胀。
    // 上限取一个比较保守的值——verification reminder 只关心"自上次成功 verify 起累积的
    // 失败指纹"，往远历史看意义不大；保留 8 个 editVersion 已经足以覆盖 turn 内回看场景。
    const MaxRetainedEditVersions = 8
    if (this.passedVerificationFingerprintsByVersion.size >= MaxRetainedEditVersions) {
      // Map 的 keys 迭代顺序就是插入顺序，因为 editVersion 单调递增，最早插入的就是最小的。
      // 把多余的"老 version"挨个删掉，直到回到 MaxRetainedEditVersions - 1，再 set 当前版本就刚好达到上限。
      const iter = this.passedVerificationFingerprintsByVersion.keys()
      while (this.passedVerificationFingerprintsByVersion.size >= MaxRetainedEditVersions) {
        const next = iter.next()
        if (next.done) break
        this.passedVerificationFingerprintsByVersion.delete(next.value)
      }
    }

    const fingerprints = new Set<string>()
    this.passedVerificationFingerprintsByVersion.set(this.editVersion, fingerprints)
    return fingerprints
  }

  private getPassedVerificationCommandsForCurrentVersion(): Set<string> {
    const existing = this.passedVerificationCommandsByVersion.get(this.editVersion)
    if (existing) return existing

    const MaxRetainedEditVersions = 8
    if (this.passedVerificationCommandsByVersion.size >= MaxRetainedEditVersions) {
      const iter = this.passedVerificationCommandsByVersion.keys()
      while (this.passedVerificationCommandsByVersion.size >= MaxRetainedEditVersions) {
        const next = iter.next()
        if (next.done) break
        this.passedVerificationCommandsByVersion.delete(next.value)
      }
    }

    const commands = new Set<string>()
    this.passedVerificationCommandsByVersion.set(this.editVersion, commands)
    return commands
  }

  private recordPassedVerificationCommandForCurrentVersion(
    toolName: string,
    args: Record<string, unknown>
  ): void {
    if (toolName !== 'system:run' && toolName !== 'project:run') return
    const command = args.command
    if (!isString(command) || !command.trim()) return

    this.getPassedVerificationCommandsForCurrentVersion().add(command.trim())
  }

  private hasPassedVerificationCommandForCurrentVersion(command: unknown): boolean {
    if (!isString(command) || !command.trim()) return false
    const cited = command.trim()
    return [...this.getPassedVerificationCommandsForCurrentVersion()].some((ran) =>
      this.verificationHelper.evidenceMatches(cited, ran)
    )
  }

  private buildVerificationToolFingerprint(
    toolName: string,
    args: Record<string, unknown>
  ): LooseOptional<string> {
    return this.verificationHelper.buildVerificationToolFingerprint(toolName, args)
  }

  private isPassedVerificationResult(toolName: string, result: unknown): boolean {
    return this.verificationHelper.isPassedVerificationResult(toolName, result)
  }
}

export type {
  CodingSessionToolCategoryToolNames,
  CodingSessionToolContext,
  CodingSessionTrackerOptions,
}
export { CodingSessionTracker }
