import { describe, expect, test } from "bun:test";

import { readRunArchiveView } from "../src/archive/index.js";
import { normalizeObservation } from "../src/detect/index.js";
import {
  assertSelfContainedHtml,
  createRunReportModel,
  findExternalResourceViolations,
  renderHistoricalReportHtml,
  renderReportHtml,
} from "../src/report/index.js";

import { archive, observation } from "./fixtures.js";

describe("archive compatibility and reports", () => {
  test("reads legacy shapes without inventing absent fields", () => {
    const v0 = readRunArchiveView([{ ok: true }]);
    const v1 = readRunArchiveView({ sessionId: "s1", rounds: [{ ok: true }] });
    const v2 = readRunArchiveView({ manifest: { runId: "r2" }, rounds: [] });
    expect(v0.shape).toBe("v0-array");
    expect(v0.passed).toBeNull();
    expect(v1.total).toBe(1);
    expect(v1.passed).toBeNull();
    expect(v1.drops).toBeNull();
    expect(v2.findings).toBeNull();
  });

  test("deduplicates cumulative debug snapshots by toolCallId", () => {
    const base = observation();
    const call = {
      id: "call-1",
      turnId: "turn-1",
      name: "read",
      input: { path: "/a" },
      result: null,
      isError: null,
      startedAt: null,
      finishedAt: null,
    } as const;
    const normalized = normalizeObservation({
      ...base,
      turns: [
        { id: "turn-1", index: 0, toolCalls: [call], finishReasons: [] },
        {
          id: "turn-2",
          index: 1,
          toolCalls: [{ ...call, turnId: "turn-2" }],
          finishReasons: [],
        },
      ],
    });
    expect(normalized.turns.flatMap((turn) => turn.toolCalls)).toHaveLength(1);
  });

  test("renders deterministic self-contained v3 and legacy reports", () => {
    const model = createRunReportModel(archive());
    const first = renderReportHtml([model], { generatedAt: 1 });
    const second = renderReportHtml([model], { generatedAt: 1 });
    expect(first).toBe(second);
    expect(findExternalResourceViolations(first)).toEqual([]);
    const historical = renderHistoricalReportHtml(
      [readRunArchiveView({ sessionId: "legacy", rounds: [] })],
      { generatedAt: 1 },
    );
    expect(historical).toContain('data-value="null">—</span>');
    expect(() =>
      assertSelfContainedHtml(
        `${historical}<script src="https://bad.invalid/x.js"></script>`,
      ),
    ).toThrow();
  });
});
