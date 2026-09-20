import type {
  Candidate, OperationReceipt, PlanSelection, PlannerDecision,
  RequestBudget, ViewIntentInput
} from "./contracts";

export const intent: ViewIntentInput = {
  kind: "semantic",
  objective: "检查 token 刷新修改是否影响 session 恢复",
  anchors: [{ kind: "resource", sourceId: "project", resourceId: "src/auth/token.ts" }],
  importance: "required",
  time: { kind: "after-step" },
  evidenceMode: "verbatim",
  forms: ["definition", "excerpt", "diff"],
  maxTokensHint: 3000
};

export const candidate: Candidate = {
  candidateId: "c1",
  target: { kind: "resource", sourceId: "fixture", resourceId: "token.ts" },
  allowedIntentIds: ["i1"],
  preview: "export function refreshToken() { /* ... */ }",
  matchReasons: ["symbol-exact"],
  allowedForms: ["definition", "excerpt"],
  estimatedTokens: 80,
  lineage: [{
    sourceId: "fixture", resourceId: "token.ts", revision: "r2",
    contentHash: "source-hash-r2", observedAt: "2026-09-19T00:00:00Z",
    consistency: "revision-checkable"
  }]
};

export const selection: PlanSelection = {
  candidateId: "c1", intentIds: ["i1"], form: "definition", reason: "读取修改后的定义"
};
export const plannerDecision: PlannerDecision = {
  kind: "select", selections: [selection], claimedCoverage: [
    { intentId: "i1", status: "partial", explanation: "尚未覆盖调用方和测试" }
  ]
};
export const budget: RequestBudget = {
  windowTokens: 16000, policyAndTools: 2000, taskAndUser: 1500,
  mandatoryFeedback: 1000, envelope: 500, outputReserve: 3000, safetyReserve: 1000
};
export const unknownWrite: OperationReceipt = {
  operationId: "op-send-1", stepId: "step-1", capabilityId: "fixture.send",
  inputHash: "request-hash-1", outcome: "unknown", effect: "write",
  idempotency: { kind: "non-idempotent" }, changedResources: []
};

// Compile-time assertions only. Runtime schema validation remains mandatory.
// @ts-expect-error Context planner cannot propose a world write.
export const invalidPlannerDecision: PlannerDecision = { kind: "write", path: "token.ts" };
// @ts-expect-error Direct requests require an explicit target.
export const invalidDirect: ViewIntentInput = {
  kind: "direct", purpose: "missing target", importance: "required",
  time: { kind: "after-step" }, evidenceMode: "verbatim", forms: ["full"]
};
