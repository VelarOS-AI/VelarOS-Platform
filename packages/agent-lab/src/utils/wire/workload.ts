/**
 * 真实任务记录、评估与复跑用例的 schema，逐个 `satisfies z.ZodType<…>` 对齐手写类型。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import { z } from 'zod'

import {
  AgentLabLimits,
  FindingSeverities,
  RealTaskArtifactProvenances,
  RealTaskAssertionKinds,
  RealTaskAssertionOutcomes,
  RealTaskAssessmentSchemaId,
  RealTaskCasePrivacyClassifications,
  RealTaskCaseSchemaId,
  RealTaskCaseSources,
  RealTaskCoverageArchetypes,
  RealTaskCoverageDataShapes,
  RealTaskCoverageInteractions,
  RealTaskCoverageLifecycles,
  RealTaskCoveragePaths,
  RealTaskCoverageRisks,
  RealTaskFeedbackVerdicts,
  RealTaskFindingClasses,
  RealTaskHealths,
  RealTaskModelRequirements,
  RealTaskPrivacyClassifications,
  RealTaskRecordSchemaId,
  RealTaskSources,
  RealTaskSpanCategories,
  RealTaskTerminalStatuses,
  RealTaskVerdicts,
} from '../../contract/constants.js'
import type {
  RealTaskAcceptanceContract,
  RealTaskArtifact,
  RealTaskAssertion,
  RealTaskAssessment,
  RealTaskAssessmentMetrics,
  RealTaskCase,
  RealTaskCaseOrigin,
  RealTaskCasePrivacy,
  RealTaskCoverage,
  RealTaskDescriptor,
  RealTaskEvidence,
  RealTaskExecutor,
  RealTaskFeedback,
  RealTaskFinding,
  RealTaskPrivacy,
  RealTaskRecord,
  RealTaskSpan,
  RealTaskSpanMetrics,
  RealTaskWorkspaceReference,
} from '../../types/agent-lab.js'

const nullableNumberSchema = z.number().finite().nonnegative().nullable()
const countSchema = z.number().int().nonnegative()
const parametersSchema = z.record(z.string(), z.unknown())
const assertionKindSchema = z.enum(RealTaskAssertionKinds)
const terminalStatusSchema = z.enum(RealTaskTerminalStatuses)

const assertionSchema = z.strictObject({
  id: z.string().min(1),
  kind: assertionKindSchema,
  description: z.string(),
  outcome: z.enum(RealTaskAssertionOutcomes),
  detail: z.string(),
  evidenceRefs: z.array(z.string()),
}) satisfies z.ZodType<RealTaskAssertion>

/** 一条验收合同：复跑时按它取证。 */
export const realTaskAcceptanceContractSchema = z.strictObject({
  id: z.string().min(1),
  kind: assertionKindSchema,
  description: z.string(),
  parameters: parametersSchema,
  gate: z.boolean(),
}) satisfies z.ZodType<RealTaskAcceptanceContract>

const spanMetricsSchema = z.strictObject({
  latencyMs: nullableNumberSchema,
  tokensIn: nullableNumberSchema,
  tokensOut: nullableNumberSchema,
  costUsd: nullableNumberSchema,
}) satisfies z.ZodType<RealTaskSpanMetrics>

const spanSchema = z.strictObject({
  id: z.string().min(1),
  category: z.enum(RealTaskSpanCategories),
  status: terminalStatusSchema,
  name: z.string(),
  startedAt: z.number().finite(),
  endedAt: z.number().finite(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCategoryId: z.string().nullable(),
  toolEffectKind: z.string().nullable(),
  errorCode: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  mutation: z.boolean(),
  metrics: spanMetricsSchema,
}) satisfies z.ZodType<RealTaskSpan>

const artifactSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string(),
  path: z.string().nullable(),
  sha256: z.string().nullable(),
  sizeBytes: nullableNumberSchema,
  provenance: z.enum(RealTaskArtifactProvenances),
}) satisfies z.ZodType<RealTaskArtifact>

const feedbackSchema = z.strictObject({
  verdict: z.enum(RealTaskFeedbackVerdicts),
  detail: z.string(),
  recordedAt: z.number().finite(),
}) satisfies z.ZodType<RealTaskFeedback>

const descriptorSchema = z.strictObject({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  rootInputId: z.string().nullable(),
  source: z.enum(RealTaskSources),
  surface: z.string().min(1),
  title: z.string(),
  prompt: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  startedAt: z.number().finite(),
  finishedAt: z.number().finite(),
  terminalStatus: terminalStatusSchema,
}) satisfies z.ZodType<RealTaskDescriptor>

const executorSchema = z.strictObject({
  executorId: z.string().min(1),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  reasoningProfile: z.string().nullable(),
}) satisfies z.ZodType<RealTaskExecutor>

const privacySchema = z.strictObject({
  classification: z.enum(RealTaskPrivacyClassifications),
  containsPrompt: z.boolean(),
  containsAnswer: z.boolean(),
  containsPaths: z.boolean(),
}) satisfies z.ZodType<RealTaskPrivacy>

const evidenceSchema = z.strictObject({
  spans: z.array(spanSchema),
  assertions: z.array(assertionSchema),
  artifacts: z.array(artifactSchema),
  finalAnswer: z.string().nullable(),
  userFeedback: feedbackSchema.nullable(),
  observationGaps: z.array(z.string()),
}) satisfies z.ZodType<RealTaskEvidence>

/** 一条真实任务记录：产品里一次普通运行留下来的全部可核证据。 */
export const realTaskRecordSchema = z.strictObject({
  schema: z.literal(RealTaskRecordSchemaId),
  id: z.string().min(1),
  capturedAt: z.number().finite(),
  task: descriptorSchema,
  executor: executorSchema,
  privacy: privacySchema,
  evidence: evidenceSchema,
}) satisfies z.ZodType<RealTaskRecord>

const realTaskFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: z.enum(FindingSeverities),
  class: z.enum(RealTaskFindingClasses),
  title: z.string(),
  detail: z.string(),
  evidenceRefs: z.array(z.string()),
}) satisfies z.ZodType<RealTaskFinding>

const assessmentMetricsSchema = z.strictObject({
  durationMs: nullableNumberSchema,
  modelCalls: countSchema,
  toolCalls: countSchema,
  toolErrors: countSchema,
  repeatedToolErrors: countSchema,
  redundantToolCalls: countSchema,
  mutations: countSchema,
  tokensIn: nullableNumberSchema,
  tokensOut: nullableNumberSchema,
  costUsd: nullableNumberSchema,
  assertionsPassed: countSchema,
  assertionsFailed: countSchema,
  assertionsUnknown: countSchema,
}) satisfies z.ZodType<RealTaskAssessmentMetrics>

/** 一次真实任务的评估。 */
export const realTaskAssessmentSchema = z.strictObject({
  schema: z.literal(RealTaskAssessmentSchemaId),
  recordId: z.string().min(1),
  generatedAt: z.number().finite(),
  outcome: z.enum(RealTaskAssertionOutcomes),
  health: z.enum(RealTaskHealths),
  verdict: z.enum(RealTaskVerdicts),
  promotionRecommended: z.boolean(),
  findings: z.array(realTaskFindingSchema),
  metrics: assessmentMetricsSchema,
}) satisfies z.ZodType<RealTaskAssessment>

const caseOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observed'), recordId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('curated'),
    rationale: z.string().min(1),
    references: z.array(z.strictObject({ title: z.string().min(1), url: z.string().url() })).min(1),
  }),
]) satisfies z.ZodType<RealTaskCaseOrigin>

const coverageSchema = z.strictObject({
  capability: z.string().min(1),
  objective: z.string().min(1),
  archetype: z.enum(RealTaskCoverageArchetypes),
  dataShapes: z.array(z.enum(RealTaskCoverageDataShapes)).min(1),
  risk: z.enum(RealTaskCoverageRisks),
  lifecycle: z.enum(RealTaskCoverageLifecycles),
  path: z.enum(RealTaskCoveragePaths),
  interaction: z.enum(RealTaskCoverageInteractions),
  modelRequirement: z.enum(RealTaskModelRequirements),
  dailyWeight: z.number().finite().positive().max(AgentLabLimits.caseDailyWeight),
}) satisfies z.ZodType<RealTaskCoverage>

const workspaceReferenceSchema = z.strictObject({
  adapter: z.string().min(1),
  parameters: parametersSchema,
  reference: z.string().min(1),
  digest: z.string().nullable(),
}) satisfies z.ZodType<RealTaskWorkspaceReference>

const casePrivacySchema = z.strictObject({
  classification: z.enum(RealTaskCasePrivacyClassifications),
  reviewNote: z.string(),
}) satisfies z.ZodType<RealTaskCasePrivacy>

/** 一条复跑用例：显式提示词、隔离工作区、至少一条验收门。 */
export const realTaskCaseSchema = z.strictObject({
  schema: z.literal(RealTaskCaseSchemaId),
  id: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.number().finite(),
  origin: caseOriginSchema,
  title: z.string(),
  prompt: z.string().min(1),
  source: z.enum(RealTaskCaseSources),
  surface: z.string().min(1),
  coverage: coverageSchema,
  workspace: workspaceReferenceSchema,
  acceptance: z.array(realTaskAcceptanceContractSchema).min(1),
  privacy: casePrivacySchema,
  labels: z.array(z.string()),
}) satisfies z.ZodType<RealTaskCase>
