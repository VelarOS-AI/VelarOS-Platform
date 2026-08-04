import type { RunArchive } from "../protocol/index.js";

import type { RealTaskCoverageOutcome } from "./Coverage.js";

export interface RunArchiveOutcome {
  readonly outcome: Exclude<RealTaskCoverageOutcome, "not-run">;
  readonly detail: string;
}

/**
 * Converts one immutable archive into the only outcome accepted by real-task coverage.
 * Hosts must not reinterpret verifier failures or attrition independently.
 */
export function classifyRunArchiveOutcome(archive: RunArchive): RunArchiveOutcome {
  if (archive.drops.length > 0) return {
      outcome: "void",
      detail: archive.drops
        .map((drop) => `${drop.cause}: ${drop.detail}`)
        .join("; "),
    };

  const failedCriteria = archive.legs.flatMap((leg) =>
    leg.criteria.flatMap((criterion) =>
      criterion.outcome.kind === "fail"
        ? [`${criterion.criterionId}: ${criterion.outcome.reason}`]
        : [],
    ),
  );
  if (
    failedCriteria.length > 0 ||
    archive.legs.some((leg) => leg.passed === false)
  ) return {
      outcome: "fail",
      detail: failedCriteria.join("; ") || archive.manifest.exitReason,
    };

  if (
    archive.legs.length > 0 &&
    archive.legs.every((leg) => leg.passed === true)
  ) return {
      outcome: "pass",
      detail: "all execution and external-truth gates passed",
    };

  return { outcome: "void", detail: archive.manifest.exitReason };
}
