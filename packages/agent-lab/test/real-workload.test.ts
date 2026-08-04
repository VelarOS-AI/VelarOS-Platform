import { describe, expect, test } from "bun:test";

import {
  auditRealTask,
  classifyRunArchiveOutcome,
  parseRealTaskRecord,
  promoteRealTaskCase,
  renderRealTaskReportHtml,
  summarizeRealTaskCoverage,
} from "../src/workload/index.js";

import { archive } from "./fixtures.js";

function record() {
  return parseRealTaskRecord({
    schema: "agent-lab/real-task@1",
    id: "task-1",
    capturedAt: 20,
    task: {
      sessionId: "session-1",
      runId: "run-1",
      rootInputId: "message-1",
      source: "user",
      surface: "project",
      title: "Fix a real persistence bug",
      prompt: "Fix the persistence bug and run the existing checks.",
      workspaceRoot: "/private/worktree",
      startedAt: 10,
      finishedAt: 20,
      terminalStatus: "ok",
    },
    executor: {
      executorId: "velar-internal",
      provider: "provider-a",
      model: "model-a",
      reasoningProfile: "high",
    },
    privacy: {
      classification: "local-only",
      containsPrompt: true,
      containsAnswer: false,
      containsPaths: true,
    },
    evidence: {
      spans: [
        {
          id: "tool-1",
          category: "tool",
          status: "error",
          name: "project_edit",
          startedAt: 11,
          endedAt: 12,
          toolCallId: "call-1",
          toolName: "project_edit",
          toolCategoryId: "project-changes",
          toolEffectKind: "write",
          errorCode: "conflict",
          provider: null,
          model: null,
          mutation: true,
          metrics: {
            latencyMs: 1,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
          },
        },
        {
          id: "tool-2",
          category: "tool",
          status: "error",
          name: "project_edit",
          startedAt: 13,
          endedAt: 14,
          toolCallId: "call-2",
          toolName: "project_edit",
          toolCategoryId: "project-changes",
          toolEffectKind: "write",
          errorCode: "conflict",
          provider: null,
          model: null,
          mutation: true,
          metrics: {
            latencyMs: 1,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
          },
        },
        {
          id: "tool-3",
          category: "tool",
          status: "error",
          name: "project_edit",
          startedAt: 15,
          endedAt: 16,
          toolCallId: "call-3",
          toolName: "project_edit",
          toolCategoryId: "project-changes",
          toolEffectKind: "write",
          errorCode: "conflict",
          provider: null,
          model: null,
          mutation: true,
          metrics: {
            latencyMs: 1,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
          },
        },
      ],
      assertions: [],
      artifacts: [],
      finalAnswer: null,
      userFeedback: null,
      observationGaps: [],
    },
  });
}

describe("real-task archive outcomes", () => {
  test("classifies pass, verifier failure, and attrition from the archive itself", () => {
    expect(classifyRunArchiveOutcome(archive())).toEqual({
      outcome: "pass",
      detail: "all execution and external-truth gates passed",
    });
    expect(classifyRunArchiveOutcome(archive({ score: 0 }))).toEqual({
      outcome: "fail",
      detail: "complete: failed",
    });
    expect(
      classifyRunArchiveOutcome(
        archive({
          score: null,
          drops: [
            {
              trialId: "trial-1",
              legId: "leg-1",
              cause: "environment-drift",
              detail: "fixture changed",
            },
          ],
        }),
      ),
    ).toEqual({
      outcome: "void",
      detail: "environment-drift: fixture changed",
    });
  });

  test("keeps an archive without a conclusive leg out of the pass denominator", () => {
    const incomplete = archive();
    expect(
      classifyRunArchiveOutcome({
        ...incomplete,
        legs: [],
      }),
    ).toEqual({ outcome: "void", detail: "completed" });
  });
});

describe("real workload evaluation", () => {
  test("keeps task outcome unknown while reporting broken repeated tool errors", () => {
    const input = record();
    const assessment = auditRealTask(input, { generatedAt: 30 });
    expect(assessment.outcome).toBe("unknown");
    expect(assessment.health).toBe("broken");
    expect(assessment.verdict).toBe("needs-review");
    expect(assessment.metrics.repeatedToolErrors).toBe(3);
    expect(assessment.metrics.redundantToolCalls).toBe(0);
    expect(assessment.promotionRecommended).toBeTrue();
    const report = renderRealTaskReportHtml(input, assessment);
    expect(report).not.toContain(input.task.prompt!);
    expect(report).not.toContain(input.task.workspaceRoot!);
  });

  test("does not call parallel fan-out a feedback retry loop", () => {
    const base = record();
    const input = parseRealTaskRecord({
      ...base,
      evidence: {
        ...base.evidence,
        spans: base.evidence.spans.map((span, index) => ({
          ...span,
          startedAt: 11 + index,
          endedAt: 20,
        })),
      },
    });
    const assessment = auditRealTask(input, { generatedAt: 30 });
    expect(assessment.metrics.repeatedToolErrors).toBe(0);
    expect(assessment.metrics.redundantToolCalls).toBe(3);
    expect(assessment.findings.some((finding) => finding.class === "retry-loop")).toBeFalse();
    expect(assessment.findings.some((finding) => finding.class === "redundant-call")).toBeTrue();
  });

  test("requires reviewed acceptance evidence before promotion", () => {
    const input = record();
    expect(() =>
      promoteRealTaskCase(input, {
        id: "case-1",
        workspace: {
          adapter: "git",
          parameters: { sourcePath: "/private/source" },
          reference: "abc123",
          digest: null,
        },
        coverage: {
          capability: "project.persistence",
          objective: "repair persisted state without corrupting unrelated records",
          archetype: "recover",
          dataShapes: ["structured"],
          risk: "reversible-write",
          lifecycle: "multi-step",
          path: "failure-recovery",
          interaction: "autonomous",
          modelRequirement: "text",
          dailyWeight: 1,
        },
        acceptance: [],
        privacy: { classification: "redacted", reviewNote: "reviewed" },
      }),
    ).toThrow("at least one deterministic acceptance contract");
    const promoted = promoteRealTaskCase(input, {
      id: "case-1",
      workspace: {
        adapter: "git",
        parameters: { sourcePath: "/private/source" },
        reference: "abc123",
        digest: null,
      },
      coverage: {
        capability: "project.persistence",
        objective: "repair persisted state without corrupting unrelated records",
        archetype: "recover",
        dataShapes: ["structured"],
        risk: "reversible-write",
        lifecycle: "multi-step",
        path: "failure-recovery",
        interaction: "autonomous",
        modelRequirement: "text",
        dailyWeight: 1,
      },
      acceptance: [
        {
          id: "tests",
          kind: "command",
          description: "existing checks pass",
          parameters: { argv: ["bun", "test"] },
          gate: true,
        },
      ],
      privacy: { classification: "redacted", reviewNote: "reviewed" },
      createdAt: 40,
    });
    expect(promoted.origin).toEqual({ kind: "observed", recordId: input.id });
  });

  test("keeps unrun and void work in the verified coverage denominator", () => {
    const base = promoteRealTaskCase(record(), {
      id: "case-coverage-a",
      workspace: {
        adapter: "manual",
        parameters: { sourcePath: "/private/source" },
        reference: "snapshot-v1",
        digest: null,
      },
      coverage: {
        capability: "system.files",
        objective: "read a bounded log window",
        archetype: "inspect",
        dataShapes: ["text"],
        risk: "read-only",
        lifecycle: "single-turn",
        path: "happy",
        interaction: "autonomous",
        modelRequirement: "text",
        dailyWeight: 3,
      },
      acceptance: [
        {
          id: "tests",
          kind: "command",
          description: "checks pass",
          parameters: { argv: ["bun", "test"] },
          gate: true,
        },
      ],
      privacy: { classification: "redacted", reviewNote: "reviewed" },
    });
    const second = {
      ...base,
      id: "case-coverage-b",
      coverage: { ...base.coverage, objective: "recover a failed edit", dailyWeight: 1 },
    };
    const third = {
      ...base,
      id: "case-coverage-c",
      coverage: { ...base.coverage, objective: "inspect a binary boundary", dailyWeight: 1 },
    };
    const [summary] = summarizeRealTaskCoverage(
      [base, second, third],
      [
        { caseId: base.id, outcome: "pass" },
        { caseId: second.id, outcome: "void" },
      ],
    );
    expect(summary?.verifiedCoverage).toBe(0.6);
    expect(summary?.conclusivePassRate).toBe(1);
    expect(summary?.voided).toBe(1);
    expect(summary?.notRun).toBe(1);
  });
});
