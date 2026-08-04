import { z } from "zod";

const NullableNumberSchema = z.number().finite().nonnegative().nullable();

export const RealTaskTerminalStatusSchema = z.enum([
  "ok",
  "error",
  "aborted",
  "unknown",
]);
export type RealTaskTerminalStatus = z.infer<
  typeof RealTaskTerminalStatusSchema
>;

export const RealTaskAssertionOutcomeSchema = z.enum([
  "pass",
  "fail",
  "unknown",
]);
export type RealTaskAssertionOutcome = z.infer<
  typeof RealTaskAssertionOutcomeSchema
>;

export const RealTaskAssertionKindSchema = z.enum([
  "answer",
  "artifact",
  "browser-state",
  "command",
  "file",
  "filesystem-state",
  "json",
  "office-artifact",
  "policy",
  "process-state",
  "runtime",
  "schedule-state",
  "tool-trace",
  "user-confirmation",
  "other",
]);
export type RealTaskAssertionKind = z.infer<
  typeof RealTaskAssertionKindSchema
>;

export const RealTaskAssertionSchema = z.strictObject({
  id: z.string().min(1),
  kind: RealTaskAssertionKindSchema,
  description: z.string(),
  outcome: RealTaskAssertionOutcomeSchema,
  detail: z.string(),
  evidenceRefs: z.array(z.string()),
});
export type RealTaskAssertion = z.infer<typeof RealTaskAssertionSchema>;

export const RealTaskAcceptanceContractSchema = z.strictObject({
  id: z.string().min(1),
  kind: RealTaskAssertionKindSchema,
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  gate: z.boolean(),
});
export type RealTaskAcceptanceContract = z.infer<
  typeof RealTaskAcceptanceContractSchema
>;

export const RealTaskSpanSchema = z.strictObject({
  id: z.string().min(1),
  category: z.enum([
    "run",
    "turn",
    "model",
    "tool",
    "capability",
    "policy",
    "other",
  ]),
  status: z.enum(["ok", "error", "aborted", "unknown"]),
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
  metrics: z.strictObject({
    latencyMs: NullableNumberSchema,
    tokensIn: NullableNumberSchema,
    tokensOut: NullableNumberSchema,
    costUsd: NullableNumberSchema,
  }),
});
export type RealTaskSpan = z.infer<typeof RealTaskSpanSchema>;

export const RealTaskArtifactSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string(),
  path: z.string().nullable(),
  sha256: z.string().nullable(),
  sizeBytes: NullableNumberSchema,
  provenance: z.enum(["agent", "runtime", "verifier", "unknown"]),
});
export type RealTaskArtifact = z.infer<typeof RealTaskArtifactSchema>;

export const RealTaskRecordSchema = z.strictObject({
  schema: z.literal("agent-lab/real-task@1"),
  id: z.string().min(1),
  capturedAt: z.number().finite(),
  task: z.strictObject({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    rootInputId: z.string().nullable(),
    source: z.enum(["user", "scheduled", "hook", "replay", "unknown"]),
    surface: z.string().min(1),
    title: z.string(),
    prompt: z.string().nullable(),
    workspaceRoot: z.string().nullable(),
    startedAt: z.number().finite(),
    finishedAt: z.number().finite(),
    terminalStatus: RealTaskTerminalStatusSchema,
  }),
  executor: z.strictObject({
    executorId: z.string().min(1),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    reasoningProfile: z.string().nullable(),
  }),
  privacy: z.strictObject({
    classification: z.enum(["local-only", "redacted", "shareable"]),
    containsPrompt: z.boolean(),
    containsAnswer: z.boolean(),
    containsPaths: z.boolean(),
  }),
  evidence: z.strictObject({
    spans: z.array(RealTaskSpanSchema),
    assertions: z.array(RealTaskAssertionSchema),
    artifacts: z.array(RealTaskArtifactSchema),
    finalAnswer: z.string().nullable(),
    userFeedback: z
      .strictObject({
        verdict: z.enum(["accepted", "rejected"]),
        detail: z.string(),
        recordedAt: z.number().finite(),
      })
      .nullable(),
    observationGaps: z.array(z.string()),
  }),
});
export type RealTaskRecord = z.infer<typeof RealTaskRecordSchema>;

export const RealTaskFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: z.enum(["fail", "warn", "info"]),
  class: z.enum([
    "acceptance",
    "execution",
    "observation-gap",
    "policy",
    "redundant-call",
    "retry-loop",
    "state",
    "tool-error",
    "unverified-change",
    "user-rejected",
  ]),
  title: z.string(),
  detail: z.string(),
  evidenceRefs: z.array(z.string()),
});
export type RealTaskFinding = z.infer<typeof RealTaskFindingSchema>;

export const RealTaskAssessmentSchema = z.strictObject({
  schema: z.literal("agent-lab/real-task-assessment@1"),
  recordId: z.string().min(1),
  generatedAt: z.number().finite(),
  outcome: z.enum(["pass", "fail", "unknown"]),
  health: z.enum(["healthy", "degraded", "broken"]),
  verdict: z.enum([
    "verified-pass",
    "verified-pass-with-issues",
    "verified-fail",
    "needs-review",
    "unknown",
  ]),
  promotionRecommended: z.boolean(),
  findings: z.array(RealTaskFindingSchema),
  metrics: z.strictObject({
    durationMs: NullableNumberSchema,
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolErrors: z.number().int().nonnegative(),
    repeatedToolErrors: z.number().int().nonnegative(),
    redundantToolCalls: z.number().int().nonnegative(),
    mutations: z.number().int().nonnegative(),
    tokensIn: NullableNumberSchema,
    tokensOut: NullableNumberSchema,
    costUsd: NullableNumberSchema,
    assertionsPassed: z.number().int().nonnegative(),
    assertionsFailed: z.number().int().nonnegative(),
    assertionsUnknown: z.number().int().nonnegative(),
  }),
});
export type RealTaskAssessment = z.infer<typeof RealTaskAssessmentSchema>;

export const RealTaskCaseOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("observed"),
    recordId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("curated"),
    rationale: z.string().min(1),
    references: z
      .array(
        z.strictObject({
          title: z.string().min(1),
          url: z.string().url(),
        }),
      )
      .min(1),
  }),
]);
export type RealTaskCaseOrigin = z.infer<typeof RealTaskCaseOriginSchema>;

export const RealTaskCoverageArchetypeSchema = z.enum([
  "inspect",
  "create",
  "transform",
  "organize",
  "execute",
  "diagnose",
  "recover",
  "monitor",
  "schedule",
  "communicate",
  "navigate",
]);
export type RealTaskCoverageArchetype = z.infer<
  typeof RealTaskCoverageArchetypeSchema
>;

export const RealTaskCoverageDataShapeSchema = z.enum([
  "text",
  "structured",
  "tree",
  "tabular",
  "document",
  "image",
  "process",
  "network",
  "browser-state",
  "mixed",
]);
export type RealTaskCoverageDataShape = z.infer<
  typeof RealTaskCoverageDataShapeSchema
>;

export const RealTaskCoverageRiskSchema = z.enum([
  "read-only",
  "reversible-write",
  "irreversible-write",
  "external-side-effect",
  "sensitive",
]);
export type RealTaskCoverageRisk = z.infer<typeof RealTaskCoverageRiskSchema>;

export const RealTaskCoverageLifecycleSchema = z.enum([
  "single-turn",
  "multi-step",
  "long-running",
  "scheduled",
  "interrupted",
  "resumed",
]);
export type RealTaskCoverageLifecycle = z.infer<
  typeof RealTaskCoverageLifecycleSchema
>;

export const RealTaskCoveragePathSchema = z.enum([
  "happy",
  "boundary",
  "failure-recovery",
  "negative-constraint",
  "permission",
  "concurrency",
]);
export type RealTaskCoveragePath = z.infer<typeof RealTaskCoveragePathSchema>;

export const RealTaskCoverageInteractionSchema = z.enum([
  "autonomous",
  "confirmation",
  "user-input",
]);
export type RealTaskCoverageInteraction = z.infer<
  typeof RealTaskCoverageInteractionSchema
>;

export const RealTaskModelRequirementSchema = z.enum(["text", "vision"]);
export type RealTaskModelRequirement = z.infer<
  typeof RealTaskModelRequirementSchema
>;

/**
 * Coverage is part of the workload contract rather than report-time labeling. A case is only a
 * distinct coverage unit when it declares a concrete capability objective and the scenario axes
 * that make it materially different from neighboring cases.
 */
export const RealTaskCoverageSchema = z.strictObject({
  capability: z.string().min(1),
  objective: z.string().min(1),
  archetype: RealTaskCoverageArchetypeSchema,
  dataShapes: z.array(RealTaskCoverageDataShapeSchema).min(1),
  risk: RealTaskCoverageRiskSchema,
  lifecycle: RealTaskCoverageLifecycleSchema,
  path: RealTaskCoveragePathSchema,
  interaction: RealTaskCoverageInteractionSchema,
  modelRequirement: RealTaskModelRequirementSchema,
  dailyWeight: z.number().finite().positive().max(10),
});
export type RealTaskCoverage = z.infer<typeof RealTaskCoverageSchema>;

export const RealTaskCaseSchema = z.strictObject({
  schema: z.literal("agent-lab/real-task-case@3"),
  id: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.number().finite(),
  origin: RealTaskCaseOriginSchema,
  title: z.string(),
  prompt: z.string().min(1),
  source: z.enum(["user", "scheduled", "hook", "replay", "curated", "unknown"]),
  surface: z.string().min(1),
  coverage: RealTaskCoverageSchema,
  workspace: z.strictObject({
    adapter: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    reference: z.string().min(1),
    digest: z.string().nullable(),
  }),
  acceptance: z.array(RealTaskAcceptanceContractSchema).min(1),
  privacy: z.strictObject({
    classification: z.enum(["redacted", "shareable"]),
    reviewNote: z.string(),
  }),
  labels: z.array(z.string()),
});
export type RealTaskCase = z.infer<typeof RealTaskCaseSchema>;

export function parseRealTaskRecord(value: unknown): RealTaskRecord {
  return RealTaskRecordSchema.parse(value);
}

export function parseRealTaskAssessment(value: unknown): RealTaskAssessment {
  return RealTaskAssessmentSchema.parse(value);
}

export function parseRealTaskCase(value: unknown): RealTaskCase {
  return RealTaskCaseSchema.parse(value);
}
