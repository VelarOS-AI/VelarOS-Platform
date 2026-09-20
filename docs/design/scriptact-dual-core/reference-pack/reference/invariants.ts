/** Pure contract examples; NOT a security boundary or full materializer. */
import type {
  Candidate, DeltaDescriptor, EvidenceId, OperationReceipt,
  PlanSelection, RequestBudget
} from "./contracts";

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
}

export function evidenceBudget(b: RequestBudget):
  | { kind: "ok"; tokens: number }
  | { kind: "blocked"; deficit: number } {
  for (const [key, value] of Object.entries(b)) assertCount(value, key);
  const fixed = b.policyAndTools + b.taskAndUser + b.mandatoryFeedback
    + b.envelope + b.outputReserve + b.safetyReserve;
  if (!Number.isSafeInteger(fixed)) throw new RangeError("Budget overflow");
  const available = b.windowTokens - fixed;
  return available < 0
    ? { kind: "blocked", deficit: -available }
    : { kind: "ok", tokens: available };
}

export function deltaCanServeAsCurrentContent(
  delta: DeltaDescriptor,
  /** Exact, complete baseline evidence physically available in this request. */
  availableBaselines: ReadonlyMap<EvidenceId, string>
): boolean {
  return delta.kind === "reconstructive-delta"
    && availableBaselines.get(delta.baseEvidenceId) === delta.baseContentHash;
}

export type SelectionValidation =
  | { ok: true }
  | { ok: false; code: string; candidateId?: string };

/** Candidate maps must already be task-scoped, ACL-filtered and redacted. */
export function validateSelections(
  selections: readonly PlanSelection[],
  candidates: ReadonlyMap<string, Candidate>,
  allowedIntentIds: ReadonlySet<string>,
  maxSelections: number
): SelectionValidation {
  assertCount(maxSelections, "maxSelections");
  if (selections.length > maxSelections) {
    return { ok: false, code: "PLAN_TOO_LARGE" };
  }
  const seen = new Set<string>();
  for (const s of selections) {
    const candidate = candidates.get(s.candidateId);
    if (!candidate) return { ok: false, code: "UNKNOWN_CANDIDATE", candidateId: s.candidateId };
    if (!candidate.allowedForms.includes(s.form)) {
      return { ok: false, code: "UNSUPPORTED_FORM", candidateId: s.candidateId };
    }
    if (!s.intentIds.length || s.intentIds.some(id =>
      !allowedIntentIds.has(id) || !candidate.allowedIntentIds.includes(id))) {
      return { ok: false, code: "INVALID_INTENT", candidateId: s.candidateId };
    }
    const key = `${s.candidateId}\u0000${s.form}`;
    if (seen.has(key)) return { ok: false, code: "DUPLICATE_SELECTION", candidateId: s.candidateId };
    seen.add(key);
  }
  return { ok: true };
}

export type RecoveryAction = "reuse-result" | "retry-read" | "reconcile" | "review" | "execute-after-authorization";
export function recoveryAction(receipt: OperationReceipt): RecoveryAction {
  if (receipt.outcome === "succeeded") return "reuse-result";
  if (receipt.outcome === "not-executed") return "execute-after-authorization";
  if (receipt.effect === "read" && receipt.idempotency.kind === "read-only") {
    return "retry-read";
  }
  // A timeout is not proof that a remote write failed. No blind retries.
  if (receipt.outcome === "unknown") return "reconcile";
  return "review";
}

export function operationInputCompatible(
  previousInputHash: string,
  nextInputHash: string
): boolean {
  return previousInputHash.length > 0 && previousInputHash === nextInputHash;
}
