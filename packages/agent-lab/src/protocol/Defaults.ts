import type {
  Budget,
  BudgetUsage,
  Observation,
  ObservationFace,
} from "./Types.js";

export const ObservationFaces = [
  "artifacts",
  "context-residency",
  "runtime",
  "transcript",
  "turns",
  "usage",
  "verifier",
] as const satisfies readonly ObservationFace[];

/**
 * 本包版本号。归档的 `harness.packageVersion` 缺省用它。
 *
 * 原来缺省写死 `"0.1.0"`，而本包 CLI 与 Desktop 调 `runJourney` 时都不传 `packageVersion`，
 * 于是**所有归档里的 harness 版本都是错的**，复跑可比性按它判等于按一个常量判。
 * 与 `package.json` 的一致由验收用例核对。
 */
export const AgentLabPackageVersion = "0.1.5";

export const UnlimitedBudget = Object.freeze({
  toolCalls: null,
  workingMs: null,
  wallClockMs: null,
  tokens: null,
  legs: null,
}) satisfies Budget;

export const EmptyBudgetUsage = Object.freeze({
  toolCalls: null,
  workingMs: null,
  wallClockMs: null,
  tokens: null,
  legs: 0,
}) satisfies BudgetUsage;

export function createUnobservedObservation(
  phase: Observation["phase"],
): Observation {
  return {
    phase,
    coverage: Object.fromEntries(
      ObservationFaces.map((face) => [face, "none"]),
    ) as Record<ObservationFace, "none">,
    transcript: [],
    turns: [],
    runtime: null,
    usage: null,
    contextResidency: [],
    artifacts: [],
    metadata: {},
  };
}
