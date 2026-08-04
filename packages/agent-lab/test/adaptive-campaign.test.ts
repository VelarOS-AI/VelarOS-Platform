import { describe, expect, test } from "bun:test";

import {
  type CampaignFailureRecord,
  parseRealTaskCase,
  reconcileCampaignProof,
  recordCampaignFailure,
  recordCampaignProof,
  selectAdaptiveCampaignTasks,
  transitionCampaignFailure,
} from "../src/workload/index.js";

function task(id: string, overrides: Record<string, unknown> = {}) {
  return parseRealTaskCase({
    schema: "agent-lab/real-task-case@3",
    id,
    version: 1,
    createdAt: 1,
    origin: {
      kind: "curated",
      rationale: "deterministic real task",
      references: [{ title: "source", url: "https://example.com" }],
    },
    title: id,
    prompt: `complete ${id}`,
    source: "curated",
    surface: "system",
    coverage: {
      capability: `system.${id}`,
      objective: `complete ${id}`,
      archetype: "transform",
      dataShapes: ["text"],
      risk: "reversible-write",
      lifecycle: "multi-step",
      path: "happy",
      interaction: "autonomous",
      modelRequirement: "text",
      dailyWeight: 1,
      ...((overrides.coverage as object | undefined) ?? {}),
    },
    workspace: { adapter: "fixture", parameters: {}, reference: "v1", digest: null },
    acceptance: [{ id: "truth", kind: "file", description: "truth", parameters: {}, gate: true }],
    privacy: { classification: "shareable", reviewNote: "synthetic" },
    labels: [],
  });
}

describe("adaptive real-task campaign", () => {
  test("reuses current passes and chooses diverse unseen evidence", () => {
    const cases = [
      task("a"),
      task("b", { coverage: { archetype: "inspect", dataShapes: ["tree"], path: "boundary" } }),
      task("c"),
    ];
    const selection = selectAdaptiveCampaignTasks({
      cases,
      revisions: cases.map((entry) => ({ taskId: entry.id, revision: "r1" })),
      evidence: [{ taskId: "a", taskRevision: "r1", outcome: "pass", failureKey: null, updatedAt: 1 }],
      failures: [],
      limit: 1,
    });

    expect(selection.reusedTaskIds).toEqual(["a"]);
    expect(selection.selected.map((entry) => entry.id)).toEqual(["b"]);
  });

  test("halts new sampling until a failure is diagnosed and fixed", () => {
    const cases = [task("a"), task("b")];
    const failures = recordCampaignFailure({
      failures: [],
      key: "tool-contract:alias",
      classification: "tool-contract",
      capability: "system.a",
      taskId: "a",
      detail: "invalid provider tool name",
      now: 1,
    });
    const blocked = selectAdaptiveCampaignTasks({
      cases,
      revisions: cases.map((entry) => ({ taskId: entry.id, revision: "r1" })),
      evidence: [],
      failures,
      limit: 10,
    });
    expect(blocked.selected).toEqual([]);
    expect(blocked.blockedFailureKeys).toEqual(["tool-contract:alias"]);
  });

  test("requires diagnosis, a fix reference, and independent proof before closing", () => {
    const initial = recordCampaignFailure({
      failures: [],
      key: "validation:shape",
      classification: "parameter-validation",
      capability: "system.write",
      taskId: "a",
      detail: "invalid arguments",
      now: 1,
    })[0]!;
    const diagnosed = transitionCampaignFailure({
      failure: initial,
      state: "diagnosed",
      rootCause: "schema allowed an ambiguous union",
    });
    const fixed = transitionCampaignFailure({
      failure: diagnosed,
      state: "fixed",
      fixReference: "commit:local",
      proofTaskIds: ["a", "b"],
    });
    const first = recordCampaignProof(fixed, "a");
    const second = recordCampaignProof(first, "b");

    expect(first.state).toBe("proving");
    expect(second.state).toBe("closed");
    expect(second.passedProofTaskIds).toEqual(["a", "b"]);
  });

  test("revokes stale proof after a ledger rebase and allows a replacement proof plan", () => {
    const proving: CampaignFailureRecord = {
      key: "evaluation:line-ending",
      classification: "evaluation-design",
      state: "proving",
      capability: "system.write",
      affectedTaskIds: ["a"],
      proofTaskIds: ["a", "removed-task"],
      passedProofTaskIds: ["a"],
      occurrences: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      detail: "strict final line ending",
      rootCause: "verifier confused logical lines with a terminal newline",
      fixReference: "verifier:line-ending",
    };

    const invalidated = reconcileCampaignProof(proving, new Set());
    expect(invalidated.state).toBe("fixed");
    expect(invalidated.passedProofTaskIds).toEqual([]);

    const revised = transitionCampaignFailure({
      failure: invalidated,
      state: "fixed",
      fixReference: "verifier:line-ending",
      proofTaskIds: ["a", "replacement-task"],
    });
    const partial = reconcileCampaignProof(revised, new Set(["a"]));
    const closed = reconcileCampaignProof(revised, new Set(["a", "replacement-task"]));
    expect(partial.state).toBe("proving");
    expect(closed.state).toBe("closed");
  });

  test("reopens a closed notebook entry on recurrence", () => {
    const closed: CampaignFailureRecord = {
      key: "runtime:timeout",
      classification: "runtime",
      state: "closed",
      capability: "system.run",
      affectedTaskIds: ["a"],
      proofTaskIds: ["a", "b", "c"],
      passedProofTaskIds: ["a", "b", "c"],
      occurrences: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      detail: "timeout",
      rootCause: "waiter leak",
      fixReference: "commit:one",
    };
    const repeated = recordCampaignFailure({
      failures: [closed],
      key: closed.key,
      classification: "runtime",
      capability: "system.run",
      taskId: "d",
      detail: "timeout again",
      now: 2,
    })[0]!;

    expect(repeated.state).toBe("open");
    expect(repeated.occurrences).toBe(2);
    expect(repeated.passedProofTaskIds).toEqual([]);
  });
});
