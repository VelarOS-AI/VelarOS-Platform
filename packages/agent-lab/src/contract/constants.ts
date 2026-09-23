/**
 * 常量表：评测线格式与判定里约定好的取值、身份与公开上限。
 * 不 import 任何东西，浏览器、渲染进程、第三方执行体的工具链都能用（从 `@velaros-ai/agent-lab/contracts` 取）。
 * 每个枚举都是一份冻结数组：手写类型由它 `typeof` 派生，zod schema 也用同一份建 `z.enum`，三处不再各写一遍。
 */

// ── 归档与报告的身份 ────────────────────────────────────────────

/** 运行归档（v3）的 schema 身份；改线格式先升这里，旧版本一律拒收，历史归档只读不写。 */
export const RunArchiveSchemaId = 'agent-lab/run@3' as const

/** 测量口径：同一个 `toolCallId` 只算一次工具调用，重复上报不重复计数。 */
export const MeasurementBasis = 'unique-tool-call' as const

/** 真实任务记录的 schema 身份。 */
export const RealTaskRecordSchemaId = 'agent-lab/real-task@1' as const

/** 真实任务评估的 schema 身份。 */
export const RealTaskAssessmentSchemaId = 'agent-lab/real-task-assessment@1' as const

/** 真实任务复跑用例的 schema 身份。 */
export const RealTaskCaseSchemaId = 'agent-lab/real-task-case@3' as const

/** 认证报告的 schema 身份。 */
export const CertificationReportSchemaId = 'agent-lab/certification@1' as const

/**
 * 本包版本号。归档的 `harness.packageVersion` 缺省用它。
 * 原来缺省写死 `0.1.0`，而 CLI 与宿主调 `runJourney` 时都不传，于是每份归档里的 harness 版本都是错的，
 * 复跑可比性按它判等于按一个常量判。与 `package.json` 的一致由验收用例核对。
 */
export const AgentLabPackageVersion = '0.2.0' as const

// ── 观测面 ─────────────────────────────────────────────────────

/** 一次观测处在哪个阶段：读归档、执行体空闲、执行体正在跑。 */
export const ObservationPhases = Object.freeze(['archive', 'idle', 'running'] as const)

/** 一个观测面被看到多少：全看得到、只看得到一部分、完全看不到。 */
export const ObservationCoverages = Object.freeze(['full', 'partial', 'none'] as const)

/** 七个观测面：驱动声明自己能看到哪几面，看不到的一律显示未知，不按 0 处理。 */
export const ObservationFaces = Object.freeze([
  'artifacts',
  'context-residency',
  'runtime',
  'transcript',
  'turns',
  'usage',
  'verifier',
] as const)

/** 会话里一条转写块的角色。 */
export const TranscriptRoles = Object.freeze([
  'assistant',
  'system',
  'tool',
  'user',
  'unknown',
] as const)

/** 会话里一条转写块的种类。 */
export const TranscriptKinds = Object.freeze([
  'artifact',
  'reasoning',
  'text',
  'tool-call',
  'tool-result',
  'unknown',
] as const)

/** 产物是谁产的：被测执行体、驱动、验证器。 */
export const ArtifactProvenances = Object.freeze(['agent', 'driver', 'verifier'] as const)

// ── 判词与失败闭集 ──────────────────────────────────────────────

/** 一条发现的严重程度。 */
export const FindingSeverities = Object.freeze(['fail', 'warn', 'info'] as const)

/** 失败闭集：一次失败只能落在这十五类里，落不进去的记 `unclassified`，不许并入最相近的那一类。 */
export const FailureClasses = Object.freeze([
  'budget-exhausted',
  'context-governance',
  'environment-unavailable',
  'execution-alignment',
  'infrastructure',
  'integrity',
  'loop',
  'output-contract',
  'permission',
  'state-corruption',
  'timeout',
  'tool-failure',
  'tool-selection',
  'unclassified',
  'verifier-failure',
] as const)

/** 丢弃原因：这些结果不进能力分子也不进分母，必须单列。 */
export const AttritionCauses = Object.freeze([
  'agent-unavailable',
  'artifact-collection-failed',
  'environment-drift',
  'environment-setup-failed',
  'harness-failure',
  'interrupted',
  'invalid-task',
  'verifier-unavailable',
] as const)

/** 探测器命中后允许触发的中止类别；`null` 表示只出判词不中止。 */
export const DetectorAbortClasses = Object.freeze(['fail', 'loop'] as const)

/** 一条判据的验证结局种类。 */
export const VerificationOutcomeKinds = Object.freeze(['pass', 'partial', 'fail', 'void'] as const)

/** 一段旅程的收敛结局种类；`continueOn` 只能填除 `settled` 外的五种。 */
export const SettleOutcomeKinds = Object.freeze([
  'settled',
  'awaiting-input',
  'aborted',
  'budget-exhausted',
  'timeout',
  'unavailable',
] as const)

/** 段可以声明「照样往下走」的那几种非收敛结局；`settled` 不在里面，它本来就是正常收敛。 */
export const ContinuableSettleOutcomeKinds = Object.freeze([
  'awaiting-input',
  'aborted',
  'budget-exhausted',
  'timeout',
  'unavailable',
] as const)

/** 预算的五个维度；超预算时报出的就是这五个名字之一。 */
export const BudgetLimits = Object.freeze([
  'toolCalls',
  'workingMs',
  'wallClockMs',
  'tokens',
  'legs',
] as const)

/** 驱动靠什么判「这一段跑完了」。 */
export const SettleSignals = Object.freeze([
  'agent-events',
  'coordinator-idle',
  'process-exit',
  'custom',
] as const)

/** 验证器与被测执行体的隔离程度。 */
export const VerifierIsolations = Object.freeze(['separate', 'shared', 'none'] as const)

/** 轮询驱动遇到审批时按哪条策略走：批准、拒绝、原地等人。 */
export const ConfirmationPolicies = Object.freeze(['approve', 'reject', 'wait'] as const)

// ── 归档视图与报告 ──────────────────────────────────────────────

/** 历史归档的形状：v3 是当前格式，其余三种只读，读不出内容时记 `missing` 或 `invalid`。 */
export const ArchiveShapes = Object.freeze([
  'v3',
  'v2-manifest',
  'v1-flat',
  'v0-array',
  'missing',
  'invalid',
] as const)

/** 报告里一条判词的分量。 */
export const VerdictLevels = Object.freeze([
  'critical',
  'warning',
  'information',
  'positive',
] as const)

// ── 统计与认证 ─────────────────────────────────────────────────

/** 两个执行体成对比较的结论。 */
export const ComparisonDecisions = Object.freeze([
  'a-better',
  'b-better',
  'inconclusive',
  'not-comparable',
] as const)

/** 认证对象的种类。 */
export const CertificationSubjectKinds = Object.freeze(['agent', 'mod'] as const)

/** 认证结论：一项判不了就是 `inconclusive`，不拿缺证据当通过。 */
export const CertificationStatuses = Object.freeze([
  'certified',
  'conditional',
  'inconclusive',
  'rejected',
] as const)

/** 认证里单项检查的结论。 */
export const CertificationCheckStatuses = Object.freeze(['pass', 'fail', 'unknown'] as const)

// ── 真实任务工作负载 ────────────────────────────────────────────

/** 一次真实任务的终态。 */
export const RealTaskTerminalStatuses = Object.freeze([
  'ok',
  'error',
  'aborted',
  'unknown',
] as const)

/** 一条验收断言的结论；判不了就是 `unknown`，不当通过。 */
export const RealTaskAssertionOutcomes = Object.freeze(['pass', 'fail', 'unknown'] as const)

/** 验收断言的十五种取证方式：外部真相从哪来。 */
export const RealTaskAssertionKinds = Object.freeze([
  'answer',
  'artifact',
  'browser-state',
  'command',
  'file',
  'filesystem-state',
  'json',
  'office-artifact',
  'policy',
  'process-state',
  'runtime',
  'schedule-state',
  'tool-trace',
  'user-confirmation',
  'other',
] as const)

/** 执行跨度的类别：整次运行、一轮、一次模型调用、一次工具调用、能力、策略、其它。 */
export const RealTaskSpanCategories = Object.freeze([
  'run',
  'turn',
  'model',
  'tool',
  'capability',
  'policy',
  'other',
] as const)

/** 真实任务产物是谁产的。 */
export const RealTaskArtifactProvenances = Object.freeze([
  'agent',
  'runtime',
  'verifier',
  'unknown',
] as const)

/** 一次真实任务是被什么触发的。 */
export const RealTaskSources = Object.freeze([
  'user',
  'scheduled',
  'hook',
  'replay',
  'unknown',
] as const)

/** 复跑用例的来源；比记录多一种「人工编写」。 */
export const RealTaskCaseSources = Object.freeze([
  'user',
  'scheduled',
  'hook',
  'replay',
  'curated',
  'unknown',
] as const)

/** 记录的内容策略：只留本机、已脱敏、可外发。 */
export const RealTaskPrivacyClassifications = Object.freeze([
  'local-only',
  'redacted',
  'shareable',
] as const)

/** 复跑用例的内容策略：用例要被复跑，不许只留本机。 */
export const RealTaskCasePrivacyClassifications = Object.freeze(['redacted', 'shareable'] as const)

/** 用例的来路：从真实记录固化，还是人工编写并给出参考。 */
export const RealTaskCaseOriginKinds = Object.freeze(['observed', 'curated'] as const)

/** 用户对一次真实任务结果的确认。 */
export const RealTaskFeedbackVerdicts = Object.freeze(['accepted', 'rejected'] as const)

/** 真实任务发现的十类问题。 */
export const RealTaskFindingClasses = Object.freeze([
  'acceptance',
  'execution',
  'observation-gap',
  'policy',
  'redundant-call',
  'retry-loop',
  'state',
  'tool-error',
  'unverified-change',
  'user-rejected',
] as const)

/** 真实任务的执行健康度。 */
export const RealTaskHealths = Object.freeze(['healthy', 'degraded', 'broken'] as const)

/** 真实任务的综合判词：任务结果与执行健康合起来说一句话。 */
export const RealTaskVerdicts = Object.freeze([
  'verified-pass',
  'verified-pass-with-issues',
  'verified-fail',
  'needs-review',
  'unknown',
] as const)

/** 覆盖统计里一条用例的结局；`not-run` 是没跑，不是通过。 */
export const RealTaskCoverageOutcomes = Object.freeze(['pass', 'fail', 'void', 'not-run'] as const)

/** 覆盖轴之一：这件事在做什么。 */
export const RealTaskCoverageArchetypes = Object.freeze([
  'inspect',
  'create',
  'transform',
  'organize',
  'execute',
  'diagnose',
  'recover',
  'monitor',
  'schedule',
  'communicate',
  'navigate',
] as const)

/** 覆盖轴之一：处理的数据长什么样。 */
export const RealTaskCoverageDataShapes = Object.freeze([
  'text',
  'structured',
  'tree',
  'tabular',
  'document',
  'image',
  'process',
  'network',
  'browser-state',
  'mixed',
] as const)

/** 覆盖轴之一：这件事的风险级别。 */
export const RealTaskCoverageRisks = Object.freeze([
  'read-only',
  'reversible-write',
  'irreversible-write',
  'external-side-effect',
  'sensitive',
] as const)

/** 覆盖轴之一：这件事的生命周期形态。 */
export const RealTaskCoverageLifecycles = Object.freeze([
  'single-turn',
  'multi-step',
  'long-running',
  'scheduled',
  'interrupted',
  'resumed',
] as const)

/** 覆盖轴之一：走的是哪条路径。 */
export const RealTaskCoveragePaths = Object.freeze([
  'happy',
  'boundary',
  'failure-recovery',
  'negative-constraint',
  'permission',
  'concurrency',
] as const)

/** 覆盖轴之一：人参与到什么程度。 */
export const RealTaskCoverageInteractions = Object.freeze([
  'autonomous',
  'confirmation',
  'user-input',
] as const)

/** 覆盖轴之一：这件事对模型能力的最低要求。 */
export const RealTaskModelRequirements = Object.freeze(['text', 'vision'] as const)

// ── 自适应战役 ─────────────────────────────────────────────────

/** 失败的根因归类；同一根因的多个用例合成一条账。 */
export const CampaignRootCauseClasses = Object.freeze([
  'environment',
  'evaluation-design',
  'prompt',
  'tool-design',
  'tool-contract',
  'parameter-validation',
  'runtime',
  'workspace-adapter',
  'model',
  'unknown',
] as const)

/** 一条失败账的处理状态；状态机只允许固定的几步流转。 */
export const CampaignFailureStates = Object.freeze([
  'open',
  'diagnosed',
  'fixed',
  'proving',
  'closed',
] as const)

// ── 公开上限与缺省表 ────────────────────────────────────────────

/** 线格式的公开上限：校验按这一组数字卡，改一处两端一起变。 */
export const AgentLabLimits = Object.freeze({
  /** 旅程、试验、判据这类标识符的字符数上限（160）。 */
  identifierChars: 160,
  /** 一个 job 的并发试验数上限（64）：再多也不是评测，是压测。 */
  jobConcurrency: 64,
  /** 运行 id 的字符数上限（200）：它要当目录名用，不能长过常见文件系统的限制。 */
  runIdChars: 200,
  /** 一条复跑用例的日常权重上限（10）：权重是相对量，再大就压掉了别的用例。 */
  caseDailyWeight: 10,
} as const)

/** 不设限的预算：五个维度全是 `null`，判超时一律不触发。 */
export const UnlimitedBudget = Object.freeze({
  /** 工具调用次数上限。 */
  toolCalls: null,
  /** 执行体真正工作的毫秒数上限。 */
  workingMs: null,
  /** 墙钟毫秒数上限。 */
  wallClockMs: null,
  /** token 上限。 */
  tokens: null,
  /** 段数上限。 */
  legs: null,
} as const)

/** 还没观测到任何用量的空账：只有段数是 0，其余维度是「不知道」。 */
export const EmptyBudgetUsage = Object.freeze({
  /** 还没数到工具调用。 */
  toolCalls: null,
  /** 还没拿到工作时长。 */
  workingMs: null,
  /** 还没拿到墙钟。 */
  wallClockMs: null,
  /** 还没拿到 token 用量。 */
  tokens: null,
  /** 已经跑完的段数。 */
  legs: 0,
} as const)

/** 打转探测的缺省阈值：`warn` 出判词，`abort` 让看门狗当场掐断。它写进归档与报告，是对外承诺的数字。 */
export const DefaultLoopThresholds = Object.freeze({
  /** 同一工具与同一参数连续重复几次开始出判词。 */
  retryWarn: 4,
  /** 同一工具与同一参数在一次等待窗口内连续重复几次就中止。 */
  retryAbort: 6,
  /** 同一张工具目录页重复读几次开始出判词。 */
  toolMapReadWarn: 3,
  /** 同一张工具目录页在一次等待窗口内重复读几次就中止。 */
  toolMapReadAbort: 4,
  /** 单轮工具调用超过多少次开始出判词。 */
  turnDensityWarn: 40,
  /** 单轮工具调用在一次等待窗口内达到多少次就中止。 */
  turnDensityAbort: 80,
} as const)

// ── 由常量表派生的取值 ──────────────────────────────────────────

/** 观测阶段的取值。 */
export type ObservationPhase = (typeof ObservationPhases)[number]

/** 观测覆盖度的取值。 */
export type ObservationCoverage = (typeof ObservationCoverages)[number]

/** 观测面的取值。 */
export type ObservationFace = (typeof ObservationFaces)[number]

/** 转写块角色的取值。 */
export type TranscriptRole = (typeof TranscriptRoles)[number]

/** 转写块种类的取值。 */
export type TranscriptKind = (typeof TranscriptKinds)[number]

/** 产物来源的取值。 */
export type ArtifactProvenance = (typeof ArtifactProvenances)[number]

/** 发现严重度的取值。 */
export type FindingSeverity = (typeof FindingSeverities)[number]

/** 失败闭集的取值。 */
export type FailureClass = (typeof FailureClasses)[number]

/** 丢弃原因的取值。 */
export type AttritionCause = (typeof AttritionCauses)[number]

/** 探测器中止类别的取值。 */
export type DetectorAbortClass = (typeof DetectorAbortClasses)[number]

/** 收敛结局种类的取值。 */
export type SettleOutcomeKind = (typeof SettleOutcomeKinds)[number]

/** 预算维度的取值。 */
export type BudgetLimit = (typeof BudgetLimits)[number]

/** 收敛信号的取值。 */
export type SettleSignal = (typeof SettleSignals)[number]

/** 验证器隔离程度的取值。 */
export type VerifierIsolation = (typeof VerifierIsolations)[number]

/** 审批策略的取值。 */
export type ConfirmationPolicy = (typeof ConfirmationPolicies)[number]

/** 归档形状的取值。 */
export type ArchiveShape = (typeof ArchiveShapes)[number]

/** 报告判词分量的取值。 */
export type VerdictLevel = (typeof VerdictLevels)[number]

/** 成对比较结论的取值。 */
export type ComparisonDecision = (typeof ComparisonDecisions)[number]

/** 认证对象种类的取值。 */
export type CertificationSubjectKind = (typeof CertificationSubjectKinds)[number]

/** 认证结论的取值。 */
export type CertificationStatus = (typeof CertificationStatuses)[number]

/** 认证单项检查结论的取值。 */
export type CertificationCheckStatus = (typeof CertificationCheckStatuses)[number]

/** 真实任务终态的取值。 */
export type RealTaskTerminalStatus = (typeof RealTaskTerminalStatuses)[number]

/** 验收断言结论的取值。 */
export type RealTaskAssertionOutcome = (typeof RealTaskAssertionOutcomes)[number]

/** 验收断言取证方式的取值。 */
export type RealTaskAssertionKind = (typeof RealTaskAssertionKinds)[number]

/** 执行跨度类别的取值。 */
export type RealTaskSpanCategory = (typeof RealTaskSpanCategories)[number]

/** 真实任务产物来源的取值。 */
export type RealTaskArtifactProvenance = (typeof RealTaskArtifactProvenances)[number]

/** 真实任务触发来源的取值。 */
export type RealTaskSource = (typeof RealTaskSources)[number]

/** 复跑用例来源的取值。 */
export type RealTaskCaseSource = (typeof RealTaskCaseSources)[number]

/** 记录内容策略的取值。 */
export type RealTaskPrivacyClassification = (typeof RealTaskPrivacyClassifications)[number]

/** 用例内容策略的取值。 */
export type RealTaskCasePrivacyClassification = (typeof RealTaskCasePrivacyClassifications)[number]

/** 用例来路的取值。 */
export type RealTaskCaseOriginKind = (typeof RealTaskCaseOriginKinds)[number]

/** 用户确认的取值。 */
export type RealTaskFeedbackVerdict = (typeof RealTaskFeedbackVerdicts)[number]

/** 真实任务发现分类的取值。 */
export type RealTaskFindingClass = (typeof RealTaskFindingClasses)[number]

/** 真实任务执行健康度的取值。 */
export type RealTaskHealth = (typeof RealTaskHealths)[number]

/** 真实任务综合判词的取值。 */
export type RealTaskVerdict = (typeof RealTaskVerdicts)[number]

/** 覆盖结局的取值。 */
export type RealTaskCoverageOutcome = (typeof RealTaskCoverageOutcomes)[number]

/** 覆盖轴「做什么」的取值。 */
export type RealTaskCoverageArchetype = (typeof RealTaskCoverageArchetypes)[number]

/** 覆盖轴「数据形状」的取值。 */
export type RealTaskCoverageDataShape = (typeof RealTaskCoverageDataShapes)[number]

/** 覆盖轴「风险」的取值。 */
export type RealTaskCoverageRisk = (typeof RealTaskCoverageRisks)[number]

/** 覆盖轴「生命周期」的取值。 */
export type RealTaskCoverageLifecycle = (typeof RealTaskCoverageLifecycles)[number]

/** 覆盖轴「路径」的取值。 */
export type RealTaskCoveragePath = (typeof RealTaskCoveragePaths)[number]

/** 覆盖轴「交互」的取值。 */
export type RealTaskCoverageInteraction = (typeof RealTaskCoverageInteractions)[number]

/** 覆盖轴「模型要求」的取值。 */
export type RealTaskModelRequirement = (typeof RealTaskModelRequirements)[number]

/** 失败根因归类的取值。 */
export type CampaignRootCauseClass = (typeof CampaignRootCauseClasses)[number]

/** 失败账状态的取值。 */
export type CampaignFailureState = (typeof CampaignFailureStates)[number]
