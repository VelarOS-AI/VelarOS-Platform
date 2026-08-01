import { z } from "zod";

import type { JobSpec, JourneySpec, JsonValue, RunArchive } from "./Types.js";

const IdentifierSchema = z.string().trim().min(1).max(160);
const NullableLimitSchema = z.number().finite().nonnegative().nullable();

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const BudgetSchema = z.strictObject({
  toolCalls: NullableLimitSchema,
  workingMs: NullableLimitSchema,
  wallClockMs: NullableLimitSchema,
  tokens: NullableLimitSchema,
  legs: NullableLimitSchema,
});

const PartialBudgetSchema = z.strictObject({
  toolCalls: NullableLimitSchema.optional(),
  workingMs: NullableLimitSchema.optional(),
  wallClockMs: NullableLimitSchema.optional(),
  tokens: NullableLimitSchema.optional(),
  legs: NullableLimitSchema.optional(),
});

const CriterionSchema = z.strictObject({
  id: IdentifierSchema,
  verifierId: IdentifierSchema,
  parameters: JsonObjectSchema,
  weight: z.number().finite().positive(),
  gate: z.boolean(),
});

const LegSchema = z.strictObject({
  id: IdentifierSchema,
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  weight: z.number().finite().positive(),
  blocking: z.boolean(),
  budget: PartialBudgetSchema.nullable(),
  continueOn: z.array(
    z.enum([
      "awaiting-input",
      "aborted",
      "budget-exhausted",
      "timeout",
      "unavailable",
    ]),
  ),
  driverParameters: JsonObjectSchema,
  criteria: z.array(CriterionSchema).min(1),
});

export const JourneySpecSchema = z
  .strictObject({
    id: IdentifierSchema,
    version: z.number().int().positive(),
    title: z.string().trim().min(1),
    description: z.string(),
    tags: z.array(IdentifierSchema),
    space: IdentifierSchema,
    budget: BudgetSchema,
    setup: z
      .strictObject({
        adapter: IdentifierSchema,
        parameters: JsonObjectSchema,
        hygiene: z.array(IdentifierSchema),
      })
      .nullable(),
    gatingDetectorIds: z.array(IdentifierSchema),
    legs: z.array(LegSchema).min(1),
  })
  .superRefine((journey, context) => {
    const legIds = new Set<string>();
    for (const [legIndex, leg] of journey.legs.entries()) {
      if (legIds.has(leg.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate leg id: ${leg.id}`,
          path: ["legs", legIndex, "id"],
        });
      }
      legIds.add(leg.id);
      const criterionIds = new Set<string>();
      for (const [criterionIndex, criterion] of leg.criteria.entries()) {
        if (criterionIds.has(criterion.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate criterion id in ${leg.id}: ${criterion.id}`,
            path: ["legs", legIndex, "criteria", criterionIndex, "id"],
          });
        }
        criterionIds.add(criterion.id);
      }
    }
    if (
      journey.budget.legs !== null &&
      journey.budget.legs < journey.legs.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Journey leg budget is smaller than the declared journey",
        path: ["budget", "legs"],
      });
    }
  });

const ReplicateSchema = z.strictObject({
  groupId: IdentifierSchema,
  index: z.number().int().positive(),
  ofK: z.number().int().positive(),
  seed: z.number().int(),
});

const TrialSchema = z
  .strictObject({
    id: IdentifierSchema,
    journeyId: IdentifierSchema,
    journeyVersion: z.number().int().positive(),
    executorId: IdentifierSchema,
    arm: IdentifierSchema.nullable(),
    replicate: ReplicateSchema,
  })
  .refine((trial) => trial.replicate.index <= trial.replicate.ofK, {
    message: "Replicate index cannot exceed ofK",
    path: ["replicate", "index"],
  });

export const JobSpecSchema = z.strictObject({
  id: IdentifierSchema,
  suiteId: IdentifierSchema,
  trials: z.array(TrialSchema).min(1),
  concurrency: z.number().int().positive().max(64),
  archiveDirectory: z.string().trim().min(1),
});

const ObservationCoverageSchema = z.enum(["full", "partial", "none"]);
const ObservationFaceSchema = z.enum([
  "artifacts",
  "context-residency",
  "runtime",
  "transcript",
  "turns",
  "usage",
  "verifier",
]);

const ObservationReferenceSchema = z.strictObject({
  face: ObservationFaceSchema,
  id: z.string(),
  detail: z.string().nullable(),
});

const FindingSchema = z.strictObject({
  detectorId: IdentifierSchema,
  severity: z.enum(["fail", "warn", "info"]),
  failureClass: z.enum([
    "budget-exhausted",
    "context-governance",
    "environment-unavailable",
    "execution-alignment",
    "infrastructure",
    "integrity",
    "loop",
    "output-contract",
    "permission",
    "state-corruption",
    "timeout",
    "tool-failure",
    "tool-selection",
    "unclassified",
    "verifier-failure",
  ]),
  summary: z.string(),
  references: z.array(ObservationReferenceSchema),
  evidence: JsonObjectSchema,
});

const UsageAccountSchema = z.strictObject({
  inputTokens: NullableLimitSchema,
  outputTokens: NullableLimitSchema,
  cacheReadTokens: NullableLimitSchema,
  cacheWriteTokens: NullableLimitSchema,
  reasoningTokens: NullableLimitSchema,
  totalTokens: NullableLimitSchema,
  costUsd: NullableLimitSchema,
});

const ContextEventSchema = z.strictObject({
  id: z.string(),
  epoch: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative().nullable(),
  cause: z.string(),
  beforeTokens: NullableLimitSchema,
  afterTokens: NullableLimitSchema,
  cacheReadDropNextRequest: z.number().finite().nullable(),
  distillCostTokens: NullableLimitSchema,
  payload: JsonObjectSchema,
});

const ArtifactReferenceSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  path: z.string().nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sizeBytes: NullableLimitSchema,
  provenance: z.enum(["agent", "driver", "verifier"]),
});

const TranscriptBlockSchema = z.strictObject({
  id: z.string(),
  messageId: z.string(),
  role: z.enum(["assistant", "system", "tool", "user", "unknown"]),
  kind: z.enum([
    "artifact",
    "reasoning",
    "text",
    "tool-call",
    "tool-result",
    "unknown",
  ]),
  text: z.string().nullable(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolInput: JsonValueSchema,
  toolResult: JsonValueSchema,
  isError: z.boolean().nullable(),
  isRunning: z.boolean().nullable(),
  isStreaming: z.boolean().nullable(),
});

const ToolCallRecordSchema = z.strictObject({
  id: z.string(),
  turnId: z.string(),
  name: z.string(),
  input: JsonValueSchema,
  result: JsonValueSchema,
  isError: z.boolean().nullable(),
  startedAt: z.number().finite().nullable(),
  finishedAt: z.number().finite().nullable(),
});

const TurnRecordSchema = z.strictObject({
  id: z.string(),
  index: z.number().int().nonnegative(),
  toolCalls: z.array(ToolCallRecordSchema),
  finishReasons: z.array(z.string()),
});

const RuntimeSnapshotSchema = z.strictObject({
  running: z.boolean().nullable(),
  awaitingConfirmation: z.boolean().nullable(),
  awaitingInput: z.boolean().nullable(),
  status: z.string().nullable(),
  contextTokens: NullableLimitSchema,
  contextWindow: NullableLimitSchema,
  contextPercent: z.number().finite().nullable(),
});

const ObservationSchema = z.strictObject({
  phase: z.enum(["archive", "idle", "running"]),
  coverage: z.strictObject({
    artifacts: ObservationCoverageSchema,
    "context-residency": ObservationCoverageSchema,
    runtime: ObservationCoverageSchema,
    transcript: ObservationCoverageSchema,
    turns: ObservationCoverageSchema,
    usage: ObservationCoverageSchema,
    verifier: ObservationCoverageSchema,
  }),
  transcript: z.array(TranscriptBlockSchema),
  turns: z.array(TurnRecordSchema),
  runtime: RuntimeSnapshotSchema.nullable(),
  usage: UsageAccountSchema.nullable(),
  contextResidency: z.array(ContextEventSchema),
  artifacts: z.array(ArtifactReferenceSchema),
  metadata: JsonObjectSchema,
});

const VerificationOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pass"),
    credit: z.literal(1),
    evidence: JsonObjectSchema,
  }),
  z.strictObject({
    kind: z.literal("partial"),
    credit: z.number().min(0).max(1),
    reason: z.string(),
    evidence: JsonObjectSchema,
  }),
  z.strictObject({
    kind: z.literal("fail"),
    credit: z.literal(0),
    failureClass: FindingSchema.shape.failureClass,
    reason: z.string(),
    evidence: JsonObjectSchema,
  }),
  z.strictObject({
    kind: z.literal("void"),
    cause: z.enum([
      "agent-unavailable",
      "artifact-collection-failed",
      "environment-drift",
      "environment-setup-failed",
      "harness-failure",
      "interrupted",
      "invalid-task",
      "verifier-unavailable",
    ]),
    detail: z.string(),
    evidence: JsonObjectSchema,
  }),
]);

const SettleOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("settled") }),
  z.strictObject({ kind: z.literal("awaiting-input") }),
  z.strictObject({
    kind: z.literal("aborted"),
    detectorId: z.string(),
    reason: z.string(),
  }),
  z.strictObject({
    kind: z.literal("budget-exhausted"),
    limit: z.enum(["toolCalls", "workingMs", "wallClockMs", "tokens", "legs"]),
  }),
  z.strictObject({ kind: z.literal("timeout") }),
  z.strictObject({
    kind: z.literal("unavailable"),
    cause: z.enum([
      "agent-unavailable",
      "artifact-collection-failed",
      "environment-drift",
      "environment-setup-failed",
      "harness-failure",
      "interrupted",
      "invalid-task",
      "verifier-unavailable",
    ]),
    detail: z.string(),
  }),
]);

const LegResultSchema = z.strictObject({
  legId: z.string(),
  startedAt: z.number().finite(),
  finishedAt: z.number().finite(),
  settleOutcome: SettleOutcomeSchema,
  criteria: z.array(
    z.strictObject({
      criterionId: z.string(),
      verifierId: z.string(),
      outcome: VerificationOutcomeSchema,
      durationMs: z.number().finite().nonnegative(),
    }),
  ),
  observation: ObservationSchema,
  findings: z.array(FindingSchema),
  score: z.number().finite().min(0).max(1).nullable(),
  passed: z.boolean().nullable(),
});

export const RunArchiveSchema = z.strictObject({
  manifest: z.strictObject({
    schema: z.literal("agent-lab/run@3"),
    runId: IdentifierSchema,
    jobId: IdentifierSchema,
    suiteId: IdentifierSchema,
    trial: TrialSchema,
    harness: z.strictObject({
      packageVersion: z.string(),
      sourceCommit: z.string().nullable(),
      consumerCommit: z.string().nullable(),
      taskDigest: z.string(),
      detectorDigest: z.string(),
      policyDigest: z.string(),
    }),
    executor: z.strictObject({
      executorId: z.string(),
      adapterVersion: z.string(),
      cliVersion: z.string().nullable(),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      modelRevision: z.string().nullable(),
      contextWindow: NullableLimitSchema,
      reasoningProfile: z.string().nullable(),
      configuration: JsonObjectSchema,
    }),
    capabilities: z.strictObject({
      observes: z.strictObject({
        artifacts: ObservationCoverageSchema,
        "context-residency": ObservationCoverageSchema,
        runtime: ObservationCoverageSchema,
        transcript: ObservationCoverageSchema,
        turns: ObservationCoverageSchema,
        usage: ObservationCoverageSchema,
        verifier: ObservationCoverageSchema,
      }),
      settleSignal: z.enum([
        "agent-events",
        "coordinator-idle",
        "process-exit",
        "custom",
      ]),
      canApproveInline: z.boolean(),
      canAbortMidRun: z.boolean(),
      verifierIsolation: z.enum(["separate", "shared", "none"]),
      preservesNativeExecution: z.boolean(),
    }),
    startedAt: z.number().finite(),
    finishedAt: z.number().finite(),
    exitReason: z.string(),
    budget: BudgetSchema,
    usage: z.strictObject({
      toolCalls: NullableLimitSchema,
      workingMs: NullableLimitSchema,
      wallClockMs: NullableLimitSchema,
      tokens: NullableLimitSchema,
      legs: z.number().int().nonnegative(),
    }),
    measurementBasis: z.literal("unique-tool-call"),
  }),
  journey: JourneySpecSchema,
  legs: z.array(LegResultSchema),
  findings: z.array(FindingSchema),
  drops: z.array(
    z.strictObject({
      trialId: z.string(),
      legId: z.string().nullable(),
      cause: VerificationOutcomeSchema.options[3].shape.cause,
      detail: z.string(),
    }),
  ),
  usage: UsageAccountSchema.nullable(),
  context: z
    .strictObject({
      peakTokens: NullableLimitSchema,
      windowLimit: NullableLimitSchema,
      epochs: z.array(ContextEventSchema),
    })
    .nullable(),
  artifacts: z.array(ArtifactReferenceSchema),
  extensions: JsonObjectSchema,
});

export function parseJourneySpec(input: unknown): JourneySpec {
  return JourneySpecSchema.parse(input) as JourneySpec;
}

export function parseJobSpec(input: unknown): JobSpec {
  return JobSpecSchema.parse(input) as JobSpec;
}

export function parseRunArchive(input: unknown): RunArchive {
  return RunArchiveSchema.parse(input) as RunArchive;
}
