/**
 * ScriptAct Dual-Core Runtime: reference contracts v0.1.
 * These are a proposed boundary, NOT an implementation or runtime validator.
 * IDs are locators, never authorization. Validate every external value.
 */
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export type TaskId = string;
export type StepId = string;
export type IntentId = string;
export type CandidateId = string;
export type EvidenceId = string;
export type ArtifactId = string;
export type Revision = string;

export interface Scope {
  tenantId: string;
  workspaceId: string;
  taskId: TaskId;
}

export type Selector =
  | { kind: "whole" }
  | { kind: "lines"; start: number; end: number }
  | { kind: "symbol"; name: string; qualifiedName?: string };

export interface ResourceTarget {
  kind: "resource";
  sourceId: string;
  resourceId: string;
  selector?: Selector;
}
export interface ArtifactTarget {
  kind: "artifact";
  artifactId: ArtifactId;
}
export interface EvidenceTarget {
  kind: "evidence";
  evidenceId: EvidenceId;
}
export type ViewTarget = ResourceTarget | ArtifactTarget | EvidenceTarget;

export type TimeRequirement =
  | { kind: "after-step" }
  | { kind: "snapshot"; snapshotId: string }
  | { kind: "historical" };

export type ViewForm =
  | "full" | "excerpt" | "definition" | "diff" | "metadata" | "summary";
export type Importance = "required" | "preferred";
export type EvidenceMode = "verbatim" | "summary-allowed";

interface IntentCommon {
  importance: Importance;
  time: TimeRequirement;
  evidenceMode: EvidenceMode;
  forms: ViewForm[];
  maxTokensHint?: number;
}
export type ViewIntentInput =
  | (IntentCommon & {
      kind: "direct";
      target: ViewTarget;
      purpose: string;
    })
  | (IntentCommon & {
      kind: "semantic";
      objective: string;
      anchors: ViewTarget[];
    });
export interface RegisteredIntent {
  schemaVersion: 1;
  intentId: IntentId;
  scope: Scope;
  stepId: StepId;
  taskRevision: number;
  registeredAt: string;
  request: ViewIntentInput;
}

export interface ReadSetEntry {
  sourceId: string;
  resourceId: string;
  revision: Revision | null;
  contentHash: string;
  observedAt: string;
  snapshotId?: string;
  consistency: "snapshot" | "revision-checkable" | "observed-only";
}
export interface SourceCapabilities {
  immutableSnapshotRead: boolean;
  validateRevision: boolean;
  atomicConditionalWrite: boolean;
  contextEligible: boolean;
}

export interface Candidate {
  candidateId: CandidateId;
  target: ViewTarget;
  allowedIntentIds: IntentId[];
  preview: string; // Already ACL-filtered and redacted.
  matchReasons: string[];
  allowedForms: ViewForm[];
  estimatedTokens: number;
  lineage: ReadSetEntry[];
}
export interface PlanSelection {
  candidateId: CandidateId;
  intentIds: IntentId[];
  form: ViewForm;
  reason: string; // Short decision note, not hidden chain of thought.
}
export interface CoverageClaim {
  intentId: IntentId;
  status: "satisfied" | "partial" | "missing";
  explanation: string;
}
export interface ContextPlan {
  schemaVersion: 1;
  planId: string; // Assigned by runtime, not trusted from model.
  scope: Scope;
  stepId: StepId;
  taskRevision: number;
  policyVersion: string;
  selections: PlanSelection[];
  claimedCoverage: CoverageClaim[];
}

/** Only a proposed decision. The runtime assigns IDs and enforces limits. */
export type PlannerDecision =
  | {
      kind: "search";
      intentId: IntentId;
      sourceId: string;
      query: string;
      limit: number;
    }
  | {
      kind: "inspect";
      candidateIds: CandidateId[];
      form: "excerpt" | "definition" | "metadata";
    }
  | {
      kind: "select";
      selections: PlanSelection[];
      claimedCoverage: CoverageClaim[];
    }
  | {
      kind: "insufficient";
      intentIds: IntentId[];
      missing: string[];
    };

export type Freshness =
  | { kind: "validated-as-of"; validatedAt: string }
  | { kind: "observed-at"; observedAt: string }
  | { kind: "historical" }
  | { kind: "stale"; reason: string };

/** A delta used as current content must have its exact base in this request. */
export type DeltaDescriptor =
  | { kind: "change-summary"; fromHash: string; toHash: string }
  | {
      kind: "reconstructive-delta";
      baseEvidenceId: EvidenceId;
      baseContentHash: string;
      targetContentHash: string;
    };

export interface EvidenceBlock {
  evidenceId: EvidenceId;
  sourceTarget: ViewTarget;
  lineage: ReadSetEntry[];
  form: ViewForm;
  body: string; // Materialized from sources; not free text from planner.
  bodyHash: string;
  trust: "source-data" | "runtime-receipt" | "model-derived";
  freshness: Freshness;
  exactness: "original" | "deterministic-transform" | "lossy-summary";
  recoveryTarget: ViewTarget;
  delta?: DeltaDescriptor;
}
export interface ContextGap {
  intentId: IntentId;
  code:
    | "NOT_FOUND" | "AMBIGUOUS" | "DENIED" | "BUDGET_EXCEEDED"
    | "SOURCE_UNSTABLE" | "SOURCE_UNAVAILABLE" | "BASELINE_MISSING"
    | "UNSUPPORTED_FORM" | "INSUFFICIENT_EVIDENCE";
  detail: string;
  required: boolean;
}
export interface TokenMeasurement {
  tokens: number;
  method: "provider-count" | "local-tokenizer" | "estimate";
}
export interface ModelView {
  schemaVersion: 1;
  viewId: string;
  scope: Scope;
  stepId: StepId;
  taskRevision: number;
  policyVersion: string;
  taskCapsule: TaskCapsule;
  mandatoryReceiptIds: string[];
  evidence: EvidenceBlock[];
  coverage: CoverageClaim[]; // Recomputed/downgraded after materialization.
  gaps: ContextGap[];
  inputTokens: TokenMeasurement;
  readSet: ReadSetEntry[];
  plannerUsed: boolean;
  builtAt: string;
}
export type MaterializationResult =
  | { kind: "ready"; view: ModelView }
  | { kind: "degraded"; view: ModelView; reasons: string[] }
  | { kind: "blocked"; code: string; detail: string; gaps: ContextGap[] };

export interface ModelStatement {
  text: string;
  evidenceIds: EvidenceId[];
  status: "hypothesis" | "decision";
}
export interface VerifiedFact {
  text: string;
  evidenceIds: EvidenceId[];
  receiptIds: string[];
  validatedAt: string;
}
export interface TaskCapsule {
  originalGoalRef: ArtifactTarget;
  constraints: string[]; // Exact user constraints or explicitly linked full text.
  phase: string;
  nextObjective: string;
  verifiedFacts: VerifiedFact[];
  statements: ModelStatement[];
  openQuestions: string[];
  attemptedOperationIds: string[];
}

export type IdempotencyPolicy =
  | { kind: "read-only" }
  | { kind: "provider-key"; key: string; statusLookupSupported: boolean }
  | { kind: "non-idempotent" };
export interface OperationReceipt {
  operationId: string;
  stepId: StepId;
  capabilityId: string;
  inputHash: string;
  outcome: "succeeded" | "failed" | "unknown" | "not-executed";
  effect: "read" | "write";
  idempotency: IdempotencyPolicy;
  resultRef?: ArtifactTarget;
  errorCode?: string;
  changedResources: ReadSetEntry[];
}
export interface ExecutionReport {
  stepId: StepId;
  outcome: "succeeded" | "failed" | "partial" | "unknown" | "cancelled";
  receipts: OperationReceipt[];
  registeredIntentIds: IntentId[];
  artifacts: ArtifactTarget[];
  diagnosticsRef?: ArtifactTarget;
  handoff?: ScriptReturn; // Model-authored task notes, never verified facts.
}
export type ScriptReturn = {
  kind: "continue";
  nextObjective: string;
  hypotheses: string[];
};
export interface ScriptCoreAPI {
  view: {
    request(input: ViewIntentInput): Promise<{ intentId: IntentId }>;
  };
  artifacts: {
    put(value: JsonValue): Promise<ArtifactTarget>;
    read(ref: ArtifactTarget, maxBytes: number): Promise<JsonValue>;
  };
}
export type ModelDecision =
  | { kind: "script"; source: string }
  | { kind: "final"; answer: string; evidenceIds: EvidenceId[] }
  | { kind: "need_user"; question: string; blockingReason: string };

export interface CallBudget {
  remainingModelCalls: number;
  remainingToolCalls: number;
  remainingInspectBytes: number;
  remainingTokens: number;
}
export interface RequestBudget {
  windowTokens: number;
  policyAndTools: number;
  taskAndUser: number;
  mandatoryFeedback: number;
  envelope: number;
  outputReserve: number;
  safetyReserve: number;
}
export interface ContextPlannerPort {
  decide(input: {
    intents: RegisteredIntent[];
    capsule: TaskCapsule;
    candidates: Candidate[];
    budget: CallBudget;
  }, signal: AbortSignal): Promise<PlannerDecision>;
}
export interface ContextSourcePort {
  readonly sourceId: string;
  readonly capabilities: SourceCapabilities;
  search(input: {
    scope: Scope;
    query: string;
    limit: number;
  }, signal: AbortSignal): Promise<Candidate[]>;
  materialize(input: {
    scope: Scope;
    target: ViewTarget;
    form: ViewForm;
    time: TimeRequirement;
    maxBytes: number;
  }, signal: AbortSignal): Promise<EvidenceBlock>;
  validate(input: {
    scope: Scope;
    readSet: ReadSetEntry[];
  }, signal: AbortSignal): Promise<{
    valid: boolean;
    changed: ReadSetEntry[];
    unknown: ReadSetEntry[];
  }>;
}
export interface MainModelPort {
  decide(view: ModelView, signal: AbortSignal): Promise<ModelDecision>;
}


export interface ExecutionContext {
  scope: Scope;
  stepId: StepId;
  taskRevision: number;
  leaseId: string;
  policyVersion: string;
}
export interface ScriptExecutorPort {
  execute(input: {
    context: ExecutionContext;
    source: string;
  }, signal: AbortSignal): Promise<ExecutionReport>;
}
export interface RevisionPrecondition {
  sourceId: string;
  resourceId: string;
  expectedRevision: Revision;
}
export interface CapabilityBrokerPort {
  invoke(input: {
    context: ExecutionContext; // Bound by host, not accepted from script claims.
    operationId: string;
    capabilityId: string;
    capabilityRevision: string;
    args: JsonValue;
    preconditions: RevisionPrecondition[];
  }, signal: AbortSignal): Promise<OperationReceipt>;
}
export interface ContextMaterializerPort {
  build(input: {
    context: ExecutionContext;
    effectsSettledSequence: number; // Journal order, NOT a global world revision.
    intents: RegisteredIntent[];
    plan: ContextPlan;
    budget: RequestBudget;
  }, signal: AbortSignal): Promise<MaterializationResult>;
}
export interface ArtifactStorePort {
  put(input: {
    scope: Scope;
    value: JsonValue;
    lineage: ReadSetEntry[];
    inheritedPolicyLabels: string[]; // Authoritative labels derived by broker.
  }, signal: AbortSignal): Promise<ArtifactTarget>;
  read(input: {
    scope: Scope;
    ref: ArtifactTarget;
    maxBytes: number;
  }, signal: AbortSignal): Promise<JsonValue>;
}
