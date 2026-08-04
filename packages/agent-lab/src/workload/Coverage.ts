import type { RealTaskCase } from "./Types.js";

export type RealTaskCoverageOutcome = "pass" | "fail" | "void" | "not-run";

export interface RealTaskCoverageResult {
  readonly caseId: string;
  readonly outcome: RealTaskCoverageOutcome;
}

export interface RealTaskSurfaceCoverageSummary {
  readonly surface: string;
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly voided: number;
  readonly notRun: number;
  readonly plannedWeight: number;
  readonly executedWeight: number;
  readonly passedWeight: number;
  /** Passed weight divided by all planned weight. Unrun and void cases remain visible as gaps. */
  readonly verifiedCoverage: number;
  /** Passed weight divided by conclusive pass/fail weight. Null until a conclusive case exists. */
  readonly conclusivePassRate: number | null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Summarizes weighted real-task coverage without turning missing evidence into a pass. Duplicate
 * results and results for unknown cases are rejected because either would silently corrupt the
 * denominator used for product claims.
 */
export function summarizeRealTaskCoverage(
  cases: readonly RealTaskCase[],
  results: readonly RealTaskCoverageResult[],
): readonly RealTaskSurfaceCoverageSummary[] {
  const byId = new Map(cases.map((taskCase) => [taskCase.id, taskCase]));
  if (byId.size !== cases.length) throw new Error("Real task case ids must be unique");

  const outcomes = new Map<string, RealTaskCoverageOutcome>();
  for (const result of results) {
    if (!byId.has(result.caseId)) {
      throw new Error(`Coverage result references unknown case: ${result.caseId}`);
    }
    if (outcomes.has(result.caseId)) {
      throw new Error(`Coverage result is duplicated for case: ${result.caseId}`);
    }
    outcomes.set(result.caseId, result.outcome);
  }

  const surfaces = new Map<string, RealTaskCase[]>();
  for (const taskCase of cases) {
    const entries = surfaces.get(taskCase.surface) ?? [];
    entries.push(taskCase);
    surfaces.set(taskCase.surface, entries);
  }

  return [...surfaces.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([surface, surfaceCases]) => {
      let passed = 0;
      let failed = 0;
      let voided = 0;
      let notRun = 0;
      let plannedWeight = 0;
      let executedWeight = 0;
      let passedWeight = 0;

      for (const taskCase of surfaceCases) {
        const weight = taskCase.coverage.dailyWeight;
        const outcome = outcomes.get(taskCase.id) ?? "not-run";
        plannedWeight += weight;
        if (outcome === "pass") {
          passed += 1;
          executedWeight += weight;
          passedWeight += weight;
        } else if (outcome === "fail") {
          failed += 1;
          executedWeight += weight;
        } else if (outcome === "void") voided += 1;
        else notRun += 1;
      }

      return {
        surface,
        cases: surfaceCases.length,
        passed,
        failed,
        voided,
        notRun,
        plannedWeight,
        executedWeight,
        passedWeight,
        verifiedCoverage: ratio(passedWeight, plannedWeight),
        conclusivePassRate:
          executedWeight === 0 ? null : ratio(passedWeight, executedWeight),
      };
    });
}
