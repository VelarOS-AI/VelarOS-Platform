export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ObservationPhase = "archive" | "idle" | "running";
export type ObservationCoverage = "full" | "partial" | "none";
export type ObservationFace =
  | "artifacts"
  | "context-residency"
  | "runtime"
  | "transcript"
  | "turns"
  | "usage"
  | "verifier";

export type FindingSeverity = "fail" | "warn" | "info";
export type FailureClass =
  | "budget-exhausted"
  | "context-governance"
  | "environment-unavailable"
  | "execution-alignment"
  | "infrastructure"
  | "integrity"
  | "loop"
  | "output-contract"
  | "permission"
  | "state-corruption"
  | "timeout"
  | "tool-failure"
  | "tool-selection"
  | "unclassified"
  | "verifier-failure";

export type AttritionCause =
  | "agent-unavailable"
  | "artifact-collection-failed"
  | "environment-drift"
  | "environment-setup-failed"
  | "harness-failure"
  | "interrupted"
  | "invalid-task"
  | "verifier-unavailable";

export interface Budget {
  readonly toolCalls: number | null;
  readonly workingMs: number | null;
  readonly wallClockMs: number | null;
  readonly tokens: number | null;
  readonly legs: number | null;
}

export interface BudgetUsage {
  readonly toolCalls: number | null;
  readonly workingMs: number | null;
  readonly wallClockMs: number | null;
  readonly tokens: number | null;
  readonly legs: number;
}

export interface PartialBudget {
  readonly toolCalls?: number | null;
  readonly workingMs?: number | null;
  readonly wallClockMs?: number | null;
  readonly tokens?: number | null;
  readonly legs?: number | null;
}

export interface CriterionSpec {
  readonly id: string;
  readonly verifierId: string;
  readonly parameters: JsonObject;
  readonly weight: number;
  readonly gate: boolean;
}

export interface LegSpec {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly weight: number;
  readonly blocking: boolean;
  readonly budget: PartialBudget | null;
  /** Non-settled native outcomes that are intentional stimuli and may advance the journey. */
  readonly continueOn: ReadonlyArray<Exclude<SettleOutcome["kind"], "settled">>;
  /** Adapter-owned controls such as run profile, scripted interruption, or approval policy. */
  readonly driverParameters: JsonObject;
  readonly criteria: readonly CriterionSpec[];
}

export interface JourneySetup {
  readonly adapter: string;
  readonly parameters: JsonObject;
  readonly hygiene: readonly string[];
}

/**
 * A versioned task that advances through every leg in one persistent session.
 * A conventional isolated benchmark item is represented as a one-leg journey.
 */
export interface JourneySpec {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly space: string;
  readonly budget: Budget;
  readonly setup: JourneySetup | null;
  readonly gatingDetectorIds: readonly string[];
  readonly legs: readonly LegSpec[];
}

export interface ReplicateIdentity {
  readonly groupId: string;
  readonly index: number;
  readonly ofK: number;
  readonly seed: number;
}

export interface TrialSpec {
  readonly id: string;
  readonly journeyId: string;
  readonly journeyVersion: number;
  readonly executorId: string;
  readonly arm: string | null;
  readonly replicate: ReplicateIdentity;
}

export interface JobSpec {
  readonly id: string;
  readonly suiteId: string;
  readonly trials: readonly TrialSpec[];
  readonly concurrency: number;
  readonly archiveDirectory: string;
}

export interface SessionSpec {
  readonly trial: TrialSpec;
  readonly journey: JourneySpec;
  readonly workspaceRoot: string | null;
}

export interface SessionHandle {
  readonly id: string;
  readonly executorId: string;
  readonly externalId: string | null;
  readonly metadata: JsonObject;
}

export interface ExecutorIdentity {
  readonly executorId: string;
  readonly adapterVersion: string;
  readonly cliVersion: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly modelRevision: string | null;
  readonly contextWindow: number | null;
  readonly reasoningProfile: string | null;
  readonly configuration: JsonObject;
}

export interface DriverCapabilities {
  readonly observes: Readonly<Record<ObservationFace, ObservationCoverage>>;
  readonly settleSignal:
    "agent-events" | "coordinator-idle" | "process-exit" | "custom";
  readonly canApproveInline: boolean;
  readonly canAbortMidRun: boolean;
  readonly verifierIsolation: "separate" | "shared" | "none";
  readonly preservesNativeExecution: boolean;
}

export interface TranscriptBlock {
  readonly id: string;
  readonly messageId: string;
  readonly role: "assistant" | "system" | "tool" | "user" | "unknown";
  readonly kind:
    "artifact" | "reasoning" | "text" | "tool-call" | "tool-result" | "unknown";
  readonly text: string | null;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly toolInput: JsonValue;
  readonly toolResult: JsonValue;
  readonly isError: boolean | null;
  readonly isRunning: boolean | null;
  readonly isStreaming: boolean | null;
}

export interface ToolCallRecord {
  readonly id: string;
  readonly turnId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly result: JsonValue;
  readonly isError: boolean | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface TurnRecord {
  readonly id: string;
  readonly index: number;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly finishReasons: readonly string[];
}

export interface RuntimeSnapshot {
  readonly running: boolean | null;
  readonly awaitingConfirmation: boolean | null;
  readonly awaitingInput: boolean | null;
  readonly status: string | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly contextPercent: number | null;
}

export interface UsageAccount {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface ContextResidencyEvent {
  readonly id: string;
  readonly epoch: number;
  readonly turn: number | null;
  readonly cause: string;
  readonly beforeTokens: number | null;
  readonly afterTokens: number | null;
  readonly cacheReadDropNextRequest: number | null;
  readonly distillCostTokens: number | null;
  readonly payload: JsonObject;
}

export interface ArtifactReference {
  readonly id: string;
  readonly kind: string;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly provenance: "agent" | "driver" | "verifier";
}

export interface Observation {
  readonly phase: ObservationPhase;
  readonly coverage: Readonly<Record<ObservationFace, ObservationCoverage>>;
  readonly transcript: readonly TranscriptBlock[];
  readonly turns: readonly TurnRecord[];
  readonly runtime: RuntimeSnapshot | null;
  readonly usage: UsageAccount | null;
  readonly contextResidency: readonly ContextResidencyEvent[];
  readonly artifacts: readonly ArtifactReference[];
  readonly metadata: JsonObject;
}

export interface ObservationReference {
  readonly face: ObservationFace;
  readonly id: string;
  readonly detail: string | null;
}

export interface Finding {
  readonly detectorId: string;
  readonly severity: FindingSeverity;
  readonly failureClass: FailureClass;
  readonly summary: string;
  readonly references: readonly ObservationReference[];
  readonly evidence: JsonObject;
}

export interface DetectorDefinition {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly face: ObservationFace;
  readonly phases: readonly ObservationPhase[];
  readonly defaultSeverity: FindingSeverity;
  readonly abortClass: "fail" | "loop" | null;
}

export type VerificationOutcome =
  | { readonly kind: "pass"; readonly credit: 1; readonly evidence: JsonObject }
  | {
      readonly kind: "partial";
      readonly credit: number;
      readonly reason: string;
      readonly evidence: JsonObject;
    }
  | {
      readonly kind: "fail";
      readonly credit: 0;
      readonly failureClass: FailureClass;
      readonly reason: string;
      readonly evidence: JsonObject;
    }
  | {
      readonly kind: "void";
      readonly cause: AttritionCause;
      readonly detail: string;
      readonly evidence: JsonObject;
    };

export interface CriterionResult {
  readonly criterionId: string;
  readonly verifierId: string;
  readonly outcome: VerificationOutcome;
  readonly durationMs: number;
}

export interface LegResult {
  readonly legId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly settleOutcome: SettleOutcome;
  readonly criteria: readonly CriterionResult[];
  readonly observation: Observation;
  readonly findings: readonly Finding[];
  readonly score: number | null;
  readonly passed: boolean | null;
}

export type SettleOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "awaiting-input" }
  | {
      readonly kind: "aborted";
      readonly detectorId: string;
      readonly reason: string;
    }
  | { readonly kind: "budget-exhausted"; readonly limit: keyof Budget }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "unavailable";
      readonly cause: AttritionCause;
      readonly detail: string;
    };

export interface DropRecord {
  readonly trialId: string;
  readonly legId: string | null;
  readonly cause: AttritionCause;
  readonly detail: string;
}

export interface HarnessIdentity {
  readonly packageVersion: string;
  readonly sourceCommit: string | null;
  readonly consumerCommit: string | null;
  readonly taskDigest: string;
  readonly detectorDigest: string;
  readonly policyDigest: string;
}

export interface RunManifest {
  readonly schema: "agent-lab/run@3";
  readonly runId: string;
  readonly jobId: string;
  readonly suiteId: string;
  readonly trial: TrialSpec;
  readonly harness: HarnessIdentity;
  readonly executor: ExecutorIdentity;
  readonly capabilities: DriverCapabilities;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly exitReason: string;
  readonly budget: Budget;
  readonly usage: BudgetUsage;
  readonly measurementBasis: "unique-tool-call";
}

export interface RunArchive {
  readonly manifest: RunManifest;
  readonly journey: JourneySpec;
  readonly legs: readonly LegResult[];
  readonly findings: readonly Finding[];
  readonly drops: readonly DropRecord[];
  readonly usage: UsageAccount | null;
  readonly context: {
    readonly peakTokens: number | null;
    readonly windowLimit: number | null;
    readonly epochs: readonly ContextResidencyEvent[];
  } | null;
  readonly artifacts: readonly ArtifactReference[];
  readonly extensions: JsonObject;
}

export interface DetectorContext {
  readonly trial: TrialSpec;
  readonly journey: JourneySpec;
  readonly leg: LegSpec | null;
}

export interface VerificationContext {
  readonly trial: TrialSpec;
  readonly journey: JourneySpec;
  readonly leg: LegSpec;
  readonly criterion: CriterionSpec;
  readonly session: SessionHandle;
  readonly observation: Observation;
  readonly workspaceRoot: string | null;
}

export type Detector = (
  observation: Observation,
  context: DetectorContext,
) => readonly Finding[];
export type Verifier = (
  context: VerificationContext,
) => Promise<VerificationOutcome> | VerificationOutcome;

export interface WatchSample {
  readonly observation: Observation;
  readonly usage: BudgetUsage;
}

export type WatchDecision =
  | { readonly kind: "continue" }
  | {
      readonly kind: "abort";
      readonly detectorId: string;
      readonly reason: string;
    };

export interface SettleRequest {
  readonly budget: Budget;
  readonly signal: AbortSignal;
  readonly onSample: (sample: WatchSample) => Promise<WatchDecision>;
}

/**
 * Executor adapters own native session lifecycle and settling semantics. The runner never infers
 * one executor's state from another executor's events.
 */
export interface LabDriver {
  readonly id: string;
  capabilities(): Promise<DriverCapabilities>;
  identity(): Promise<ExecutorIdentity>;
  openSession(spec: SessionSpec): Promise<SessionHandle>;
  prepare(session: SessionHandle, setup: JourneySetup | null): Promise<void>;
  send(session: SessionHandle, leg: LegSpec): Promise<void>;
  waitSettled(
    session: SessionHandle,
    request: SettleRequest,
  ): Promise<SettleOutcome>;
  collect(
    session: SessionHandle,
    phase: ObservationPhase,
  ): Promise<Observation>;
  abort(session: SessionHandle, reason: string): Promise<void>;
  closeSession(session: SessionHandle): Promise<void>;
}
