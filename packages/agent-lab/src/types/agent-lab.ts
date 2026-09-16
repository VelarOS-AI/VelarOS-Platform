/**
 * 可移植数据：评测线格式与判定结果里流过的每一种形状。
 * 只从常量表 import type（一行），不带函数成员、不碰 Node 类型，随 `@velaros-ai/agent-lab/contracts` 出包。
 * 这里是线格式的**单一来源**：`utils/wire/` 的 zod schema 逐个 `satisfies z.ZodType<…>` 对齐它们，走形就编译不过。
 */
import type { ArchiveShape, ArtifactProvenance, AttritionCause, CampaignFailureState, CampaignRootCauseClass, CertificationCheckStatus, CertificationStatus, CertificationSubjectKind, ComparisonDecision, ConfirmationPolicy, DetectorAbortClass, FailureClass, FindingSeverity, MeasurementBasis, ObservationCoverage, ObservationFace, ObservationPhase, RealTaskArtifactProvenance, RealTaskAssertionKind, RealTaskAssertionOutcome, RealTaskCaseOriginKind, RealTaskCasePrivacyClassification, RealTaskCaseSource, RealTaskCoverageArchetype, RealTaskCoverageDataShape, RealTaskCoverageInteraction, RealTaskCoverageLifecycle, RealTaskCoverageOutcome, RealTaskCoveragePath, RealTaskCoverageRisk, RealTaskFeedbackVerdict, RealTaskFindingClass, RealTaskHealth, RealTaskModelRequirement, RealTaskPrivacyClassification, RealTaskSource, RealTaskSpanCategory, RealTaskTerminalStatus, RealTaskVerdict, RunArchiveSchemaId, SettleOutcomeKind, SettleSignal, TranscriptKind, TranscriptRole, VerdictLevel, VerifierIsolation } from '../contract/constants.js'

// ── JSON ───────────────────────────────────────────────────────

/** JSON 里的基元值。 */
export type JsonPrimitive = boolean | number | string | null

/** 任意一个 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]

/** 一个 JSON 对象；证据、参数、元数据都是它。 */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

// ── 预算 ───────────────────────────────────────────────────────

/** 一次旅程的预算；每一维 `null` 表示不设限。 */
export interface Budget {
  readonly toolCalls: number | null
  readonly workingMs: number | null
  readonly wallClockMs: number | null
  readonly tokens: number | null
  readonly legs: number | null
}

/** 已经用掉多少；`null` 表示这一维没观测到，不是 0。段数一定有值。 */
export interface BudgetUsage {
  readonly toolCalls: number | null
  readonly workingMs: number | null
  readonly wallClockMs: number | null
  readonly tokens: number | null
  readonly legs: number
}

/** 段预算：只写要覆盖的那几维，没写的沿用整程预算。 */
export interface PartialBudget {
  readonly toolCalls?: number | null
  readonly workingMs?: number | null
  readonly wallClockMs?: number | null
  readonly tokens?: number | null
  readonly legs?: number | null
}

// ── 旅程与试验 ─────────────────────────────────────────────────

/** 一条判据：交给哪个验证器、参数是什么、占多少权重、是不是门。 */
export interface CriterionSpec {
  readonly id: string
  readonly verifierId: string
  readonly parameters: JsonObject
  readonly weight: number
  readonly gate: boolean
}

/** 旅程里的一段：一次提示词、一组判据，连同它自己的预算与驱动参数。 */
export interface LegSpec {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly weight: number
  readonly blocking: boolean
  readonly budget: PartialBudget | null
  /** 哪些非收敛的原生结局是有意为之的刺激，可以继续往下走。 */
  readonly continueOn: ReadonlyArray<Exclude<SettleOutcomeKind, 'settled'>>
  /** 驱动自己认的控制项：运行档位、脚本化打断、审批策略之类。 */
  readonly driverParameters: JsonObject
  readonly criteria: readonly CriterionSpec[]
}

/** 跑之前要把工作区准备成什么样。 */
export interface JourneySetup {
  readonly adapter: string
  readonly parameters: JsonObject
  readonly hygiene: readonly string[]
}

/**
 * 一条带版本的连续旅程：在同一个会话里把每一段依次走完。
 * 常见的孤立基准题在这里就是「只有一段的旅程」。
 */
export interface JourneySpec {
  readonly id: string
  readonly version: number
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly space: string
  readonly budget: Budget
  readonly setup: JourneySetup | null
  readonly gatingDetectorIds: readonly string[]
  readonly legs: readonly LegSpec[]
}

/** 重复试验的身份：同一组里的第几次、一共几次、随机种子。 */
export interface ReplicateIdentity {
  readonly groupId: string
  readonly index: number
  readonly ofK: number
  readonly seed: number
}

/** 一次试验：哪条旅程、哪个执行体、哪个实验臂、第几次重复。 */
export interface TrialSpec {
  readonly id: string
  readonly journeyId: string
  readonly journeyVersion: number
  readonly executorId: string
  readonly arm: string | null
  readonly replicate: ReplicateIdentity
}

/** 一个 job：一批试验、并发度、归档写到哪。 */
export interface JobSpec {
  readonly id: string
  readonly suiteId: string
  readonly trials: readonly TrialSpec[]
  readonly concurrency: number
  readonly archiveDirectory: string
}

/** 造一批矩阵试验要的输入：旅程 × 执行体 × 实验臂 × 重复次数。 */
export interface MatrixJobInput {
  readonly id: string
  readonly suiteId: string
  readonly journeyIds: ReadonlyArray<{ readonly id: string; readonly version: number }>
  readonly executorIds: readonly string[]
  readonly arms?: ReadonlyArray<string | null>
  readonly replicates?: number
  readonly seed?: number
  readonly concurrency?: number
  readonly archiveDirectory: string
}

// ── 会话与执行体 ────────────────────────────────────────────────

/** 开一个会话要交给驱动的东西。 */
export interface SessionSpec {
  readonly trial: TrialSpec
  readonly journey: JourneySpec
  readonly workspaceRoot: string | null
}

/** 驱动开出来的会话句柄；`metadata` 由驱动自己定。 */
export interface SessionHandle {
  readonly id: string
  readonly executorId: string
  readonly externalId: string | null
  readonly metadata: JsonObject
}

/** 被测执行体的身份：谁在跑、什么版本、什么模型。 */
export interface ExecutorIdentity {
  readonly executorId: string
  readonly adapterVersion: string
  readonly cliVersion: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly modelRevision: string | null
  readonly contextWindow: number | null
  readonly reasoningProfile: string | null
  readonly configuration: JsonObject
}

/** 驱动声明自己能做到什么：看得到哪几面、靠什么判收敛、能不能就地批准或中途中止。 */
export interface DriverCapabilities {
  readonly observes: Readonly<Record<ObservationFace, ObservationCoverage>>
  readonly settleSignal: SettleSignal
  readonly canApproveInline: boolean
  readonly canAbortMidRun: boolean
  readonly verifierIsolation: VerifierIsolation
  readonly preservesNativeExecution: boolean
}

// ── 观测 ───────────────────────────────────────────────────────

/** 会话里的一条转写块。 */
export interface TranscriptBlock {
  readonly id: string
  readonly messageId: string
  readonly role: TranscriptRole
  readonly kind: TranscriptKind
  readonly text: string | null
  readonly toolCallId: string | null
  readonly toolName: string | null
  readonly toolInput: JsonValue
  readonly toolResult: JsonValue
  readonly isError: boolean | null
  readonly isRunning: boolean | null
  readonly isStreaming: boolean | null
}

/** 一次工具调用；`id` 就是去重用的 `toolCallId`。 */
export interface ToolCallRecord {
  readonly id: string
  readonly turnId: string
  readonly name: string
  readonly input: JsonValue
  readonly result: JsonValue
  readonly isError: boolean | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

/** 一轮：这一轮里的工具调用与结束原因。 */
export interface TurnRecord {
  readonly id: string
  readonly index: number
  readonly toolCalls: readonly ToolCallRecord[]
  readonly finishReasons: readonly string[]
}

/** 执行体当下的运行态快照。 */
export interface RuntimeSnapshot {
  readonly running: boolean | null
  readonly awaitingConfirmation: boolean | null
  readonly awaitingInput: boolean | null
  readonly status: string | null
  readonly contextTokens: number | null
  readonly contextWindow: number | null
  readonly contextPercent: number | null
}

/** token 与费用账。 */
export interface UsageAccount {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly reasoningTokens: number | null
  readonly totalTokens: number | null
  readonly costUsd: number | null
}

/** 一次上下文驻留事件：压缩、蒸馏、重建前后各是多少 token。 */
export interface ContextResidencyEvent {
  readonly id: string
  readonly epoch: number
  readonly turn: number | null
  readonly cause: string
  readonly beforeTokens: number | null
  readonly afterTokens: number | null
  readonly cacheReadDropNextRequest: number | null
  readonly distillCostTokens: number | null
  readonly payload: JsonObject
}

/** 一件产物的引用：本体不进归档，只留身份与摘要。 */
export interface ArtifactReference {
  readonly id: string
  readonly kind: string
  readonly path: string | null
  readonly sha256: string | null
  readonly sizeBytes: number | null
  readonly provenance: ArtifactProvenance
}

/** 一次观测：这一刻驱动能看到的全部东西，以及每一面看到了多少。 */
export interface Observation {
  readonly phase: ObservationPhase
  readonly coverage: Readonly<Record<ObservationFace, ObservationCoverage>>
  readonly transcript: readonly TranscriptBlock[]
  readonly turns: readonly TurnRecord[]
  readonly runtime: RuntimeSnapshot | null
  readonly usage: UsageAccount | null
  readonly contextResidency: readonly ContextResidencyEvent[]
  readonly artifacts: readonly ArtifactReference[]
  readonly metadata: JsonObject
}

/** 判词指向观测里的哪一处。 */
export interface ObservationReference {
  readonly face: ObservationFace
  readonly id: string
  readonly detail: string | null
}

// ── 判词与验证 ─────────────────────────────────────────────────

/** 一条发现：哪个探测器、多严重、属于哪一类失败、指向哪些证据。 */
export interface Finding {
  readonly detectorId: string
  readonly severity: FindingSeverity
  readonly failureClass: FailureClass
  readonly summary: string
  readonly references: readonly ObservationReference[]
  readonly evidence: JsonObject
}

/** 一个探测器的自述：看哪一面、在哪些阶段跑、命中后是不是要中止。 */
export interface DetectorDefinition {
  readonly id: string
  readonly version: number
  readonly description: string
  readonly face: ObservationFace
  readonly phases: readonly ObservationPhase[]
  readonly defaultSeverity: FindingSeverity
  readonly abortClass: DetectorAbortClass | null
}

/** 一条判据的验证结局；`void` 是「判不了」，既不算通过也不算失败。 */
export type VerificationOutcome =
  | { readonly kind: 'pass'; readonly credit: 1; readonly evidence: JsonObject }
  | { readonly kind: 'partial'; readonly credit: number; readonly reason: string; readonly evidence: JsonObject }
  | {
      readonly kind: 'fail'
      readonly credit: 0
      readonly failureClass: FailureClass
      readonly reason: string
      readonly evidence: JsonObject
    }
  | { readonly kind: 'void'; readonly cause: AttritionCause; readonly detail: string; readonly evidence: JsonObject }

/** 一条判据跑出来的结果。 */
export interface CriterionResult {
  readonly criterionId: string
  readonly verifierId: string
  readonly outcome: VerificationOutcome
  readonly durationMs: number
}

/** 一段的收敛结局。 */
export type SettleOutcome =
  | { readonly kind: 'settled' }
  | { readonly kind: 'awaiting-input' }
  | { readonly kind: 'aborted'; readonly detectorId: string; readonly reason: string }
  | { readonly kind: 'budget-exhausted'; readonly limit: keyof Budget }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable'; readonly cause: AttritionCause; readonly detail: string }

/** 一段跑完的结果：怎么收敛的、判据怎么判、看到了什么、得几分。 */
export interface LegResult {
  readonly legId: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly settleOutcome: SettleOutcome
  readonly criteria: readonly CriterionResult[]
  readonly observation: Observation
  readonly findings: readonly Finding[]
  readonly score: number | null
  readonly passed: boolean | null
}

/** 一条丢弃记录：这一项因环境或基础设施原因不算数。 */
export interface DropRecord {
  readonly trialId: string
  readonly legId: string | null
  readonly cause: AttritionCause
  readonly detail: string
}

// ── 归档 ───────────────────────────────────────────────────────

/** 这次运行是哪一套 harness 跑的：版本、两侧源码提交、三个摘要。 */
export interface HarnessIdentity {
  readonly packageVersion: string
  readonly sourceCommit: string | null
  readonly consumerCommit: string | null
  readonly taskDigest: string
  readonly detectorDigest: string
  readonly policyDigest: string
}

/** 归档头：这次运行的身份、执行体、能力、时间、预算与用量。 */
export interface RunManifest {
  readonly schema: typeof RunArchiveSchemaId
  readonly runId: string
  readonly jobId: string
  readonly suiteId: string
  readonly trial: TrialSpec
  readonly harness: HarnessIdentity
  readonly executor: ExecutorIdentity
  readonly capabilities: DriverCapabilities
  readonly startedAt: number
  readonly finishedAt: number
  readonly exitReason: string
  readonly budget: Budget
  readonly usage: BudgetUsage
  readonly measurementBasis: typeof MeasurementBasis
}

/** 归档里的上下文账：峰值、窗口上限与每一次驻留事件。 */
export interface RunArchiveContext {
  readonly peakTokens: number | null
  readonly windowLimit: number | null
  readonly epochs: readonly ContextResidencyEvent[]
}

/** 一份运行归档（v3）：写下去就不再改，报告与统计都只读它。 */
export interface RunArchive {
  readonly manifest: RunManifest
  readonly journey: JourneySpec
  readonly legs: readonly LegResult[]
  readonly findings: readonly Finding[]
  readonly drops: readonly DropRecord[]
  readonly usage: UsageAccount | null
  readonly context: RunArchiveContext | null
  readonly artifacts: readonly ArtifactReference[]
  readonly extensions: JsonObject
}

/** 读任意一代归档得到的视图：缺的字段一律是 `null`，不借 0 表达。 */
export interface RunArchiveView {
  readonly shape: ArchiveShape
  readonly archive: RunArchive | null
  readonly manifest: JsonObject | null
  readonly runId: string | null
  readonly sessionId: string | null
  readonly rounds: readonly JsonValue[]
  readonly passed: number | null
  readonly total: number | null
  readonly findings: readonly JsonValue[] | null
  readonly drops: readonly JsonValue[] | null
  readonly usage: JsonObject | null
  readonly context: JsonObject | null
  readonly raw: JsonValue | null
  readonly errors: readonly string[]
}

/** 在一个目录里找到的一份归档。 */
export interface DiscoveredRunArchive {
  readonly directory: string
  readonly path: string
  readonly source: 'report' | 'progress'
  readonly view: RunArchiveView
}

/** 一次归档发现的结果：找到哪些、跳过几个目录、哪些目录读不出来。 */
export interface RunArchiveDiscovery {
  readonly archives: readonly DiscoveredRunArchive[]
  readonly skippedDirectories: number
  readonly unreadableDirectories: readonly string[]
}

/** 一份归档折成真实任务覆盖统计认的那一种结局。 */
export interface RunArchiveOutcome {
  readonly outcome: Exclude<RealTaskCoverageOutcome, 'not-run'>
  readonly detail: string
}

// ── 探测与看门狗 ────────────────────────────────────────────────

/** 探测器看到的上下文：哪次试验、哪条旅程、哪一段。 */
export interface DetectorContext {
  readonly trial: TrialSpec
  readonly journey: JourneySpec
  readonly leg: LegSpec | null
}

/** 验证器看到的上下文：连同会话与这一刻的观测。 */
export interface VerificationContext {
  readonly trial: TrialSpec
  readonly journey: JourneySpec
  readonly leg: LegSpec
  readonly criterion: CriterionSpec
  readonly session: SessionHandle
  readonly observation: Observation
  readonly workspaceRoot: string | null
}

/** 打转探测的阈值：`warn` 出判词，`abort` 让看门狗当场掐断。 */
export interface LoopThresholds {
  readonly retryWarn: number
  readonly retryAbort: number
  readonly toolMapReadWarn: number
  readonly toolMapReadAbort: number
  readonly turnDensityWarn: number
  readonly turnDensityAbort: number
}

/**
 * 内置探测器的可调项。两份工具名单由宿主给：本包是 host 无关的，核心里不写任何产品的工具名，
 * 不给就不出对应的那类判词。
 */
export interface BuiltinDetectorOptions {
  /** 打转阈值；只写要改的那几项，其余沿用常量表里的缺省阈值。 */
  readonly thresholds?: Partial<LoopThresholds>
  /** 哪些工具是「工具目录页」：同一页反复读算发现失败。宿主不给就不出 `toolmap-read-loop`。 */
  readonly catalogToolNames?: readonly string[]
  /** 哪些工具会向用户提问：它的调用没有终态结果是正常的，判词降为 info。 */
  readonly interactiveToolNames?: readonly string[]
}

/** 进入一次等待窗口前记下的基线：窗口内只看增量，不把上一段攒的次数算到这一段头上。 */
export interface WatchdogBaseline {
  readonly counts: Readonly<Record<string, number>>
  readonly findingKeys: readonly string[]
}

/** 看门狗给出的中止：哪个探测器要求掐断、理由是什么。理由会原样发给被测执行体。 */
export interface WatchdogAbort {
  readonly detectorId: string
  readonly reason: string
}

/** 等待过程中的一次采样：这一刻的观测与用量。 */
export interface WatchSample {
  readonly observation: Observation
  readonly usage: BudgetUsage
}

/** 看了一次采样以后的裁决：继续等，还是当场中止。 */
export type WatchDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'abort'; readonly detectorId: string; readonly reason: string }

// ── 驱动 ───────────────────────────────────────────────────────

/** 轮询适配器报上来的原生执行态：只说执行体自己怎么样，不做判断。 */
export interface NativeExecutionState {
  readonly running: boolean
  readonly awaitingConfirmation: boolean
  /** 当前采样实际观察到的审批身份；不能在发送回复时重查代填。 */
  readonly confirmationId?: string | null
  readonly awaitingInput: boolean
  /** 执行体原生的单调完成栅栏，例如一个消息 id 或进程世代。 */
  readonly revision: string | null
  readonly usage: BudgetUsage
  readonly unavailable: { readonly detail: string } | null
}

/** 轮询驱动的策略：多久问一次、连续几次空闲算收敛、没给墙钟预算时等多久、遇到审批怎么办。 */
export interface PollingDriverPolicy {
  readonly pollMs: number
  readonly settlePolls: number
  readonly defaultWallClockMs: number
  readonly confirmation: ConfirmationPolicy
}

// ── 报告 ───────────────────────────────────────────────────────

/** 报告里的一条判词。 */
export interface ReportVerdict {
  readonly id: string
  readonly level: VerdictLevel
  readonly title: string
  readonly detail: string
}

/** 报告里的一处数据缺口：这一面没看全，相关指标只能是未知。 */
export interface ReportDataGap {
  readonly face: ObservationFace | 'history'
  readonly title: string
  readonly effect: string
}

/** 报告里的一段。 */
export interface LegReportModel {
  readonly id: string
  readonly title: string
  readonly durationMs: number
  readonly score: number | null
  readonly passed: boolean | null
  readonly settleKind: string
  readonly toolCalls: number | null
  readonly contextPercent: number | null
  readonly findingCounts: Readonly<Record<FindingSeverity, number>>
}

/** 一次运行的报告模型：HTML 只是它的一种呈现。 */
export interface RunReportModel {
  readonly runId: string
  readonly journeyId: string
  readonly journeyVersion: number
  readonly journeyTitle: string
  readonly executorId: string
  readonly executorLabel: string
  readonly startedAt: number
  readonly durationMs: number
  readonly passedLegs: number | null
  readonly totalLegs: number
  readonly completion: number | null
  readonly toolCalls: number | null
  readonly totalTokens: number | null
  readonly costUsd: number | null
  readonly drops: number
  readonly failureCounts: Readonly<Partial<Record<FailureClass, number>>>
  readonly verdicts: readonly ReportVerdict[]
  readonly gaps: readonly ReportDataGap[]
  readonly legs: readonly LegReportModel[]
  readonly archive: RunArchive
}

/** 渲染报告时可以给的两项：标题与生成时间；生成时间不给就显示未知。 */
export interface ReportRenderOptions {
  readonly title?: string
  readonly generatedAt?: number
}

// ── 统计 ───────────────────────────────────────────────────────

/** 一个点估计连同它的 95% 区间；样本不够时三项都是 `null`。 */
export interface IntervalEstimate {
  readonly estimate: number | null
  readonly lower95: number | null
  readonly upper95: number | null
  readonly observations: number
}

/** 单次可靠性：成功几次、尝试几次、丢弃几次。 */
export interface ReliabilityEstimate extends IntervalEstimate {
  readonly successes: number
  readonly attempts: number
  readonly dropped: number
}

/** 失败形态分布；`unclassified` 单独数，不并进其它类。 */
export interface FailureDistribution {
  readonly classified: number
  readonly unclassified: number
  readonly byClass: Readonly<Partial<Record<FailureClass, number>>>
}

/** 两组归档能不能比：不能比时给出每一条理由。 */
export interface ComparabilityResult {
  readonly comparable: boolean
  readonly reasons: readonly string[]
}

/** 两个执行体的成对比较结果。 */
export interface PairedComparison {
  readonly executorA: string
  readonly executorB: string
  readonly completionDifference: IntervalEstimate
  readonly decision: ComparisonDecision
  readonly minimumEffect: number
  readonly matchedPairs: number
  readonly clusters: number
  readonly attrition: { readonly a: number; readonly b: number; readonly either: number }
  readonly failureA: FailureDistribution
  readonly failureB: FailureDistribution
  readonly comparability: ComparabilityResult
}

/** 成对比较的可调项：最小可判效应、bootstrap 次数、随机种子。 */
export interface PairedComparisonOptions {
  readonly minimumEffect?: number
  readonly bootstrapSamples?: number
  readonly seed?: number
}

// ── 认证 ───────────────────────────────────────────────────────

/** 被认证的对象：是谁、什么版本、内容摘要多少。 */
export interface CertificationSubject {
  readonly kind: CertificationSubjectKind
  readonly id: string
  readonly version: string
  readonly digest: string
}

/** 一份认证策略：要跑哪些旅程、重复几次、可靠性下界多少、观测面要求多少。 */
export interface CertificationPolicy {
  readonly id: string
  readonly version: number
  readonly requiredJourneyIds: readonly string[]
  readonly minimumReplicatesPerJourney: number
  readonly minimumReliability: number
  readonly maximumAttritionRate: number
  readonly requiredObservationCoverage: Readonly<
    Partial<Record<ObservationFace, Exclude<ObservationCoverage, 'none'>>>
  >
  readonly requireSeparateVerifier: boolean
  readonly requireNativeExecution: boolean
  readonly requireBaseline: boolean
  readonly maximumBaselineRegression: number
}

/** 认证里的一项检查；判不了是 `unknown`，不当通过。 */
export interface CertificationCheck {
  readonly id: string
  readonly status: CertificationCheckStatus
  readonly summary: string
  readonly evidence: Readonly<Record<string, boolean | number | string | null>>
}

/** 一份认证报告；`digest` 是它自己的内容摘要。 */
export interface CertificationReport {
  readonly schema: 'agent-lab/certification@1'
  readonly subject: CertificationSubject
  readonly policy: CertificationPolicy
  readonly status: CertificationStatus
  readonly checks: readonly CertificationCheck[]
  readonly runIds: readonly string[]
  readonly baselineRunIds: readonly string[]
  readonly issuedAt: number
  readonly digest: string
}

// ── 真实任务工作负载 ────────────────────────────────────────────

/** 一条验收断言的取证结果。 */
export interface RealTaskAssertion {
  readonly id: string
  readonly kind: RealTaskAssertionKind
  readonly description: string
  readonly outcome: RealTaskAssertionOutcome
  readonly detail: string
  readonly evidenceRefs: readonly string[]
}

/** 复跑用例里的一条验收合同：复跑时按它取证。 */
export interface RealTaskAcceptanceContract {
  readonly id: string
  readonly kind: RealTaskAssertionKind
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly gate: boolean
}

/** 执行跨度里的量：延迟、进出 token、费用。 */
export interface RealTaskSpanMetrics {
  readonly latencyMs: number | null
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly costUsd: number | null
}

/** 一次真实任务里的一段执行跨度。 */
export interface RealTaskSpan {
  readonly id: string
  readonly category: RealTaskSpanCategory
  readonly status: RealTaskTerminalStatus
  readonly name: string
  readonly startedAt: number
  readonly endedAt: number
  readonly toolCallId: string | null
  readonly toolName: string | null
  readonly toolCategoryId: string | null
  readonly toolEffectKind: string | null
  readonly errorCode: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly mutation: boolean
  readonly metrics: RealTaskSpanMetrics
}

/** 真实任务产生的一件产物。 */
export interface RealTaskArtifact {
  readonly id: string
  readonly kind: string
  readonly path: string | null
  readonly sha256: string | null
  readonly sizeBytes: number | null
  readonly provenance: RealTaskArtifactProvenance
}

/** 用户对一次真实任务结果的确认。 */
export interface RealTaskFeedback {
  readonly verdict: RealTaskFeedbackVerdict
  readonly detail: string
  readonly recordedAt: number
}

/** 一次真实任务本身：从哪来、跑了多久、怎么结束的。 */
export interface RealTaskDescriptor {
  readonly sessionId: string
  readonly runId: string
  readonly rootInputId: string | null
  readonly source: RealTaskSource
  readonly surface: string
  readonly title: string
  readonly prompt: string | null
  readonly workspaceRoot: string | null
  readonly startedAt: number
  readonly finishedAt: number
  readonly terminalStatus: RealTaskTerminalStatus
}

/** 记录里执行体的身份。 */
export interface RealTaskExecutor {
  readonly executorId: string
  readonly provider: string | null
  readonly model: string | null
  readonly reasoningProfile: string | null
}

/** 记录的内容策略：这份记录里带了什么，能不能外发。 */
export interface RealTaskPrivacy {
  readonly classification: RealTaskPrivacyClassification
  readonly containsPrompt: boolean
  readonly containsAnswer: boolean
  readonly containsPaths: boolean
}

/** 记录里的证据：跨度、验收断言、产物、最终回答、用户确认与观测缺口。 */
export interface RealTaskEvidence {
  readonly spans: readonly RealTaskSpan[]
  readonly assertions: readonly RealTaskAssertion[]
  readonly artifacts: readonly RealTaskArtifact[]
  readonly finalAnswer: string | null
  readonly userFeedback: RealTaskFeedback | null
  readonly observationGaps: readonly string[]
}

/** 一条真实任务记录：产品里一次普通运行留下来的全部可核证据。 */
export interface RealTaskRecord {
  readonly schema: 'agent-lab/real-task@1'
  readonly id: string
  readonly capturedAt: number
  readonly task: RealTaskDescriptor
  readonly executor: RealTaskExecutor
  readonly privacy: RealTaskPrivacy
  readonly evidence: RealTaskEvidence
}

/** 审计一次真实任务得到的一条发现。 */
export interface RealTaskFinding {
  readonly id: string
  readonly severity: FindingSeverity
  readonly class: RealTaskFindingClass
  readonly title: string
  readonly detail: string
  readonly evidenceRefs: readonly string[]
}

/** 审计出来的量：调用了多少、错了多少、重复了多少、验收过了几条。 */
export interface RealTaskAssessmentMetrics {
  readonly durationMs: number | null
  readonly modelCalls: number
  readonly toolCalls: number
  readonly toolErrors: number
  readonly repeatedToolErrors: number
  readonly redundantToolCalls: number
  readonly mutations: number
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly costUsd: number | null
  readonly assertionsPassed: number
  readonly assertionsFailed: number
  readonly assertionsUnknown: number
}

/** 一次真实任务的评估：任务结果由验收证据定，执行健康由跨度定，两件事分开说。 */
export interface RealTaskAssessment {
  readonly schema: 'agent-lab/real-task-assessment@1'
  readonly recordId: string
  readonly generatedAt: number
  readonly outcome: RealTaskAssertionOutcome
  readonly health: RealTaskHealth
  readonly verdict: RealTaskVerdict
  readonly promotionRecommended: boolean
  readonly findings: readonly RealTaskFinding[]
  readonly metrics: RealTaskAssessmentMetrics
}

/** 审计时可以给的一项：生成时间；不给就取当下。 */
export interface RealTaskAuditOptions {
  readonly generatedAt?: number
}

/** 用例的来路：从一条真实记录固化，或人工编写并给出参考出处。 */
export type RealTaskCaseOrigin =
  | { readonly kind: Extract<RealTaskCaseOriginKind, 'observed'>; readonly recordId: string }
  | {
      readonly kind: Extract<RealTaskCaseOriginKind, 'curated'>
      readonly rationale: string
      readonly references: ReadonlyArray<{ readonly title: string; readonly url: string }>
    }

/**
 * 覆盖是工作负载合同的一部分，不是报告时贴的标签。一条用例只有声明了具体的能力目标，
 * 以及让它和邻居实质不同的那几个场景轴，才算一个独立的覆盖单元。
 */
export interface RealTaskCoverage {
  readonly capability: string
  readonly objective: string
  readonly archetype: RealTaskCoverageArchetype
  readonly dataShapes: readonly RealTaskCoverageDataShape[]
  readonly risk: RealTaskCoverageRisk
  readonly lifecycle: RealTaskCoverageLifecycle
  readonly path: RealTaskCoveragePath
  readonly interaction: RealTaskCoverageInteraction
  readonly modelRequirement: RealTaskModelRequirement
  readonly dailyWeight: number
}

/** 复跑用例要落到哪个隔离工作区上。 */
export interface RealTaskWorkspaceReference {
  readonly adapter: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly reference: string
  readonly digest: string | null
}

/** 复跑用例的内容策略与人工复核结论。 */
export interface RealTaskCasePrivacy {
  readonly classification: RealTaskCasePrivacyClassification
  readonly reviewNote: string
}

/** 一条复跑用例：显式提示词、隔离工作区、至少一条验收门。 */
export interface RealTaskCase {
  readonly schema: 'agent-lab/real-task-case@3'
  readonly id: string
  readonly version: number
  readonly createdAt: number
  readonly origin: RealTaskCaseOrigin
  readonly title: string
  readonly prompt: string
  readonly source: RealTaskCaseSource
  readonly surface: string
  readonly coverage: RealTaskCoverage
  readonly workspace: RealTaskWorkspaceReference
  readonly acceptance: readonly RealTaskAcceptanceContract[]
  readonly privacy: RealTaskCasePrivacy
  readonly labels: readonly string[]
}

/** 把一条真实记录固化成复跑用例要补的东西。 */
export interface PromoteRealTaskCaseInput {
  readonly id: string
  readonly version?: number
  readonly prompt?: string
  readonly workspace: RealTaskWorkspaceReference
  readonly coverage: RealTaskCoverage
  readonly acceptance: readonly RealTaskAcceptanceContract[]
  readonly privacy: RealTaskCasePrivacy
  readonly labels?: readonly string[]
  readonly createdAt?: number
}

/** 一条用例这次跑成什么样。 */
export interface RealTaskCoverageResult {
  readonly caseId: string
  readonly outcome: RealTaskCoverageOutcome
}

/** 一个产品面的加权覆盖小结。 */
export interface RealTaskSurfaceCoverageSummary {
  readonly surface: string
  readonly cases: number
  readonly passed: number
  readonly failed: number
  readonly voided: number
  readonly notRun: number
  readonly plannedWeight: number
  readonly executedWeight: number
  readonly passedWeight: number
  /** 通过权重 ÷ 全部计划权重；没跑与判不了的仍然看得见，是缺口。 */
  readonly verifiedCoverage: number
  /** 通过权重 ÷ 有结论（通过或失败）的权重；一条结论都没有时是 `null`。 */
  readonly conclusivePassRate: number | null
}

/** 一条工具尝试回执：真实执行回执里被拿来算输入效率的那几个字段。 */
export interface ToolAttemptReceiptRecord {
  readonly sessionId?: string
  readonly toolName: string
  readonly toolCallId: string
  readonly serializedResult: string
}

/** 模型重复输入的减少量；字符数不是 token 估算，内部尝试仍计入分母。 */
export interface ToolInputEfficiency {
  readonly attempts: number
  readonly completed: number
  readonly notApplied: number
  readonly unknown: number
  readonly reusedAttempts: number
  readonly completedReusedAttempts: number
  readonly requestedChars: number
  readonly effectiveChars: number
  readonly avoidedRepeatChars: number
  readonly corruptReceipts: number
}

// ── 自适应战役 ─────────────────────────────────────────────────

/** 一条用例在某个修订版下跑出来的最新证据。 */
export interface CampaignEvidence {
  readonly taskId: string
  readonly taskRevision: string
  readonly outcome: RealTaskCoverageOutcome
  readonly failureKey: string | null
  readonly updatedAt: number
}

/** 一条失败账：同一根因归一条，修完要有证明任务通过才关。 */
export interface CampaignFailureRecord {
  readonly key: string
  readonly classification: CampaignRootCauseClass
  readonly state: CampaignFailureState
  readonly capability: string
  readonly affectedTaskIds: readonly string[]
  readonly proofTaskIds: readonly string[]
  readonly passedProofTaskIds: readonly string[]
  readonly occurrences: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly detail: string
  readonly rootCause: string | null
  readonly fixReference: string | null
}

/** 一条用例当前的修订版；证据对不上修订版就不算数。 */
export interface CampaignTaskRevision {
  readonly taskId: string
  readonly revision: string
}

/** 选出来的下一批：选了哪些、复用了哪些、去重掉哪些、被哪些失败挡住。 */
export interface AdaptiveCampaignSelection {
  readonly selected: readonly RealTaskCase[]
  readonly reusedTaskIds: readonly string[]
  readonly duplicateTaskIds: readonly string[]
  readonly blockedFailureKeys: readonly string[]
  readonly scores: Readonly<Record<string, number>>
}

/** 选下一批要看的全部账：用例、修订版、证据、失败账与这次最多选几条。 */
export interface AdaptiveCampaignInput {
  readonly cases: readonly RealTaskCase[]
  readonly revisions: readonly CampaignTaskRevision[]
  readonly evidence: readonly CampaignEvidence[]
  readonly failures: readonly CampaignFailureRecord[]
  readonly limit: number
}

/** 记一次失败要给的东西。 */
export interface RecordCampaignFailureInput {
  readonly failures: readonly CampaignFailureRecord[]
  readonly key: string
  readonly classification: CampaignRootCauseClass
  readonly capability: string
  readonly taskId: string
  readonly detail: string
  readonly now: number
}

/** 让一条失败账换状态要给的东西；状态机不允许的流转当场报错。 */
export interface TransitionCampaignFailureInput {
  readonly failure: CampaignFailureRecord
  readonly state: CampaignFailureState
  readonly classification?: CampaignRootCauseClass
  readonly rootCause?: string | null
  readonly fixReference?: string | null
  readonly proofTaskIds?: readonly string[]
}

// ── 命令行 ─────────────────────────────────────────────────────

/** 跑完一条命令的结果：退出码与两个流的文字；写出去是可执行壳的事。 */
export interface AgentLabCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}
