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
