/**
 * 旅程、试验、job 与运行归档（v3）的 schema。每一个都 `satisfies z.ZodType<…>` 对齐 `types/agent-lab.ts` 里手写的类型，
 * schema 与类型走形这里编译就红——不再靠 `as` 强转把两边糊上。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import { z } from 'zod'

import {
  AgentLabLimits,
  ArtifactProvenances,
  AttritionCauses,
  BudgetLimits,
  ContinuableSettleOutcomeKinds,
  FailureClasses,
  FindingSeverities,
  MeasurementBasis,
  ObservationCoverages,
  ObservationFaces,
  ObservationPhases,
  RunArchiveSchemaId,
  SettleSignals,
  TranscriptKinds,
  TranscriptRoles,
  VerifierIsolations,
} from '../../contract/constants.js'
import type {
  ArtifactReference,
  Budget,
  BudgetUsage,
  ContextResidencyEvent,
  CriterionResult,
  CriterionSpec,
  DriverCapabilities,
  DropRecord,
  ExecutorIdentity,
  Finding,
  HarnessIdentity,
  JobSpec,
  JourneySetup,
  JourneySpec,
  LegResult,
  LegSpec,
  Observation,
  ObservationReference,
  PartialBudget,
  ReplicateIdentity,
  RunArchive,
  RunArchiveContext,
  RunManifest,
  RuntimeSnapshot,
  SettleOutcome,
  ToolCallRecord,
  TranscriptBlock,
  TrialSpec,
  TurnRecord,
  UsageAccount,
  VerificationOutcome,
} from '../../types/agent-lab.js'

import {
  identifierSchema,
  jsonObjectSchema,
  jsonValueSchema,
  nonEmptyTextSchema,
  nullableLimitSchema,
} from './primitives.js'

const observationCoverageSchema = z.enum(ObservationCoverages)
const observationFaceSchema = z.enum(ObservationFaces)
const failureClassSchema = z.enum(FailureClasses)
const attritionCauseSchema = z.enum(AttritionCauses)
const coverageMapSchema = z.record(observationFaceSchema, observationCoverageSchema)

/** 预算：五个维度，每一维要么是非负有限数，要么是 `null`。 */
export const budgetSchema = z.strictObject({
  toolCalls: nullableLimitSchema,
  workingMs: nullableLimitSchema,
  wallClockMs: nullableLimitSchema,
  tokens: nullableLimitSchema,
  legs: nullableLimitSchema,
}) satisfies z.ZodType<Budget>

const partialBudgetSchema = z.strictObject({
  toolCalls: nullableLimitSchema.optional(),
  workingMs: nullableLimitSchema.optional(),
  wallClockMs: nullableLimitSchema.optional(),
  tokens: nullableLimitSchema.optional(),
  legs: nullableLimitSchema.optional(),
}) satisfies z.ZodType<PartialBudget>

const budgetUsageSchema = z.strictObject({
  toolCalls: nullableLimitSchema,
  workingMs: nullableLimitSchema,
  wallClockMs: nullableLimitSchema,
  tokens: nullableLimitSchema,
  legs: z.number().int().nonnegative(),
}) satisfies z.ZodType<BudgetUsage>

const criterionSchema = z.strictObject({
  id: identifierSchema,
  verifierId: identifierSchema,
  parameters: jsonObjectSchema,
  weight: z.number().finite().positive(),
  gate: z.boolean(),
}) satisfies z.ZodType<CriterionSpec>

const legSchema = z.strictObject({
  id: identifierSchema,
  title: nonEmptyTextSchema,
  prompt: nonEmptyTextSchema,
  weight: z.number().finite().positive(),
  blocking: z.boolean(),
  budget: partialBudgetSchema.nullable(),
  continueOn: z.array(z.enum(ContinuableSettleOutcomeKinds)),
  driverParameters: jsonObjectSchema,
  criteria: z.array(criterionSchema).min(1),
}) satisfies z.ZodType<LegSpec>

const journeySetupSchema = z.strictObject({
  adapter: identifierSchema,
  parameters: jsonObjectSchema,
  hygiene: z.array(identifierSchema),
}) satisfies z.ZodType<JourneySetup>

/** 旅程定义：段 id 与判据 id 都不许重复，段预算也不能小过实际声明的段数。 */
export const journeySpecSchema = z
  .strictObject({
    id: identifierSchema,
    version: z.number().int().positive(),
    title: nonEmptyTextSchema,
    description: z.string(),
    tags: z.array(identifierSchema),
    space: identifierSchema,
    budget: budgetSchema,
    setup: journeySetupSchema.nullable(),
    gatingDetectorIds: z.array(identifierSchema),
    legs: z.array(legSchema).min(1),
  })
  .superRefine((journey, context) => {
    const legIds = new Set<string>()
    for (const [legIndex, leg] of journey.legs.entries()) {
      if (legIds.has(leg.id)) {
        context.addIssue({
          code: 'custom',
          message: `段 id 重复: ${leg.id}`,
          path: ['legs', legIndex, 'id'],
        })
      }
      legIds.add(leg.id)
      const criterionIds = new Set<string>()
      for (const [criterionIndex, criterion] of leg.criteria.entries()) {
        if (criterionIds.has(criterion.id)) {
          context.addIssue({
            code: 'custom',
            message: `段 ${leg.id} 里的判据 id 重复: ${criterion.id}`,
            path: ['legs', legIndex, 'criteria', criterionIndex, 'id'],
          })
        }
        criterionIds.add(criterion.id)
      }
    }
    if (journey.budget.legs !== null && journey.budget.legs < journey.legs.length) {
      context.addIssue({
        code: 'custom',
        message: '旅程的段数预算小于它自己声明的段数',
        path: ['budget', 'legs'],
      })
    }
  }) satisfies z.ZodType<JourneySpec>

const replicateSchema = z.strictObject({
  groupId: identifierSchema,
  index: z.number().int().positive(),
  ofK: z.number().int().positive(),
  seed: z.number().int(),
}) satisfies z.ZodType<ReplicateIdentity>

const trialSchema = z
  .strictObject({
    id: identifierSchema,
    journeyId: identifierSchema,
    journeyVersion: z.number().int().positive(),
    executorId: identifierSchema,
    arm: identifierSchema.nullable(),
    replicate: replicateSchema,
  })
  .refine((trial) => trial.replicate.index <= trial.replicate.ofK, {
    message: '重复试验的序号不能大于总次数',
    path: ['replicate', 'index'],
  }) satisfies z.ZodType<TrialSpec>

/** 一个 job：至少一次试验，并发度按常量表的上限卡。 */
export const jobSpecSchema = z.strictObject({
  id: identifierSchema,
  suiteId: identifierSchema,
  trials: z.array(trialSchema).min(1),
  concurrency: z.number().int().positive().max(AgentLabLimits.jobConcurrency),
  archiveDirectory: nonEmptyTextSchema,
}) satisfies z.ZodType<JobSpec>

const observationReferenceSchema = z.strictObject({
  face: observationFaceSchema,
  id: z.string(),
  detail: z.string().nullable(),
}) satisfies z.ZodType<ObservationReference>

const findingSchema = z.strictObject({
  detectorId: identifierSchema,
  severity: z.enum(FindingSeverities),
  failureClass: failureClassSchema,
  summary: z.string(),
  references: z.array(observationReferenceSchema),
  evidence: jsonObjectSchema,
}) satisfies z.ZodType<Finding>

const usageAccountSchema = z.strictObject({
  inputTokens: nullableLimitSchema,
  outputTokens: nullableLimitSchema,
  cacheReadTokens: nullableLimitSchema,
  cacheWriteTokens: nullableLimitSchema,
  reasoningTokens: nullableLimitSchema,
  totalTokens: nullableLimitSchema,
  costUsd: nullableLimitSchema,
}) satisfies z.ZodType<UsageAccount>

const contextEventSchema = z.strictObject({
  id: z.string(),
  epoch: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative().nullable(),
  cause: z.string(),
  beforeTokens: nullableLimitSchema,
  afterTokens: nullableLimitSchema,
  cacheReadDropNextRequest: z.number().finite().nullable(),
  distillCostTokens: nullableLimitSchema,
  payload: jsonObjectSchema,
}) satisfies z.ZodType<ContextResidencyEvent>

const artifactReferenceSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  path: z.string().nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sizeBytes: nullableLimitSchema,
  provenance: z.enum(ArtifactProvenances),
}) satisfies z.ZodType<ArtifactReference>

const transcriptBlockSchema = z.strictObject({
  id: z.string(),
  messageId: z.string(),
  role: z.enum(TranscriptRoles),
  kind: z.enum(TranscriptKinds),
  text: z.string().nullable(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolInput: jsonValueSchema,
  toolResult: jsonValueSchema,
  isError: z.boolean().nullable(),
  isRunning: z.boolean().nullable(),
  isStreaming: z.boolean().nullable(),
}) satisfies z.ZodType<TranscriptBlock>

const toolCallRecordSchema = z.strictObject({
  id: z.string(),
  turnId: z.string(),
  name: z.string(),
  input: jsonValueSchema,
  result: jsonValueSchema,
  isError: z.boolean().nullable(),
  startedAt: z.number().finite().nullable(),
  finishedAt: z.number().finite().nullable(),
}) satisfies z.ZodType<ToolCallRecord>

const turnRecordSchema = z.strictObject({
  id: z.string(),
  index: z.number().int().nonnegative(),
  toolCalls: z.array(toolCallRecordSchema),
  finishReasons: z.array(z.string()),
}) satisfies z.ZodType<TurnRecord>

const runtimeSnapshotSchema = z.strictObject({
  running: z.boolean().nullable(),
  awaitingConfirmation: z.boolean().nullable(),
  awaitingInput: z.boolean().nullable(),
  status: z.string().nullable(),
  contextTokens: nullableLimitSchema,
  contextWindow: nullableLimitSchema,
  contextPercent: z.number().finite().nullable(),
}) satisfies z.ZodType<RuntimeSnapshot>

const observationSchema = z.strictObject({
  phase: z.enum(ObservationPhases),
  coverage: coverageMapSchema,
  transcript: z.array(transcriptBlockSchema),
  turns: z.array(turnRecordSchema),
  runtime: runtimeSnapshotSchema.nullable(),
  usage: usageAccountSchema.nullable(),
  contextResidency: z.array(contextEventSchema),
  artifacts: z.array(artifactReferenceSchema),
  metadata: jsonObjectSchema,
}) satisfies z.ZodType<Observation>

const verificationOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pass'), credit: z.literal(1), evidence: jsonObjectSchema }),
  z.strictObject({
    kind: z.literal('partial'),
    credit: z.number().min(0).max(1),
    reason: z.string(),
    evidence: jsonObjectSchema,
  }),
  z.strictObject({
    kind: z.literal('fail'),
    credit: z.literal(0),
    failureClass: failureClassSchema,
    reason: z.string(),
    evidence: jsonObjectSchema,
  }),
  z.strictObject({
    kind: z.literal('void'),
    cause: attritionCauseSchema,
    detail: z.string(),
    evidence: jsonObjectSchema,
  }),
]) satisfies z.ZodType<VerificationOutcome>

const settleOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('settled') }),
  z.strictObject({ kind: z.literal('awaiting-input') }),
  z.strictObject({ kind: z.literal('aborted'), detectorId: z.string(), reason: z.string() }),
  z.strictObject({ kind: z.literal('budget-exhausted'), limit: z.enum(BudgetLimits) }),
  z.strictObject({ kind: z.literal('timeout') }),
  z.strictObject({
    kind: z.literal('unavailable'),
    cause: attritionCauseSchema,
    detail: z.string(),
  }),
]) satisfies z.ZodType<SettleOutcome>

const criterionResultSchema = z.strictObject({
  criterionId: z.string(),
  verifierId: z.string(),
  outcome: verificationOutcomeSchema,
  durationMs: z.number().finite().nonnegative(),
}) satisfies z.ZodType<CriterionResult>

const legResultSchema = z.strictObject({
  legId: z.string(),
  startedAt: z.number().finite(),
  finishedAt: z.number().finite(),
  settleOutcome: settleOutcomeSchema,
  criteria: z.array(criterionResultSchema),
  observation: observationSchema,
  findings: z.array(findingSchema),
  score: z.number().finite().min(0).max(1).nullable(),
  passed: z.boolean().nullable(),
}) satisfies z.ZodType<LegResult>

const harnessIdentitySchema = z.strictObject({
  packageVersion: z.string(),
  sourceCommit: z.string().nullable(),
  consumerCommit: z.string().nullable(),
  taskDigest: z.string(),
  detectorDigest: z.string(),
  policyDigest: z.string(),
}) satisfies z.ZodType<HarnessIdentity>

const executorIdentitySchema = z.strictObject({
  executorId: z.string(),
  adapterVersion: z.string(),
  cliVersion: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  modelRevision: z.string().nullable(),
  contextWindow: nullableLimitSchema,
  reasoningProfile: z.string().nullable(),
  configuration: jsonObjectSchema,
}) satisfies z.ZodType<ExecutorIdentity>

const driverCapabilitiesSchema = z.strictObject({
  observes: coverageMapSchema,
  settleSignal: z.enum(SettleSignals),
  canApproveInline: z.boolean(),
  canAbortMidRun: z.boolean(),
  verifierIsolation: z.enum(VerifierIsolations),
  preservesNativeExecution: z.boolean(),
}) satisfies z.ZodType<DriverCapabilities>

const runManifestSchema = z.strictObject({
  schema: z.literal(RunArchiveSchemaId),
  runId: identifierSchema,
  jobId: identifierSchema,
  suiteId: identifierSchema,
  trial: trialSchema,
  harness: harnessIdentitySchema,
  executor: executorIdentitySchema,
  capabilities: driverCapabilitiesSchema,
  startedAt: z.number().finite(),
  finishedAt: z.number().finite(),
  exitReason: z.string(),
  budget: budgetSchema,
  usage: budgetUsageSchema,
  measurementBasis: z.literal(MeasurementBasis),
}) satisfies z.ZodType<RunManifest>

const dropRecordSchema = z.strictObject({
  trialId: z.string(),
  legId: z.string().nullable(),
  cause: attritionCauseSchema,
  detail: z.string(),
}) satisfies z.ZodType<DropRecord>

const runArchiveContextSchema = z.strictObject({
  peakTokens: nullableLimitSchema,
  windowLimit: nullableLimitSchema,
  epochs: z.array(contextEventSchema),
}) satisfies z.ZodType<RunArchiveContext>

/** 运行归档（v3）：写下去就不再改，报告与统计都只读它。未声明的字段一律拒收。 */
export const runArchiveSchema = z.strictObject({
  manifest: runManifestSchema,
  journey: journeySpecSchema,
  legs: z.array(legResultSchema),
  findings: z.array(findingSchema),
  drops: z.array(dropRecordSchema),
  usage: usageAccountSchema.nullable(),
  context: runArchiveContextSchema.nullable(),
  artifacts: z.array(artifactReferenceSchema),
  extensions: jsonObjectSchema,
}) satisfies z.ZodType<RunArchive>
