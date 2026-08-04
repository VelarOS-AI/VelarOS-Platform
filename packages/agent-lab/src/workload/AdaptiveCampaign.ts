import type { RealTaskCase } from "./Types.js";

export type CampaignOutcome = "pass" | "fail" | "void" | "not-run";

export type RootCauseClass =
  | "environment"
  | "evaluation-design"
  | "prompt"
  | "tool-design"
  | "tool-contract"
  | "parameter-validation"
  | "runtime"
  | "workspace-adapter"
  | "model"
  | "unknown";

export type FailureResolutionState =
  "open" | "diagnosed" | "fixed" | "proving" | "closed";

export interface CampaignEvidence {
  readonly taskId: string;
  readonly taskRevision: string;
  readonly outcome: CampaignOutcome;
  readonly failureKey: string | null;
  readonly updatedAt: number;
}

export interface CampaignFailureRecord {
  readonly key: string;
  readonly classification: RootCauseClass;
  readonly state: FailureResolutionState;
  readonly capability: string;
  readonly affectedTaskIds: readonly string[];
  readonly proofTaskIds: readonly string[];
  readonly passedProofTaskIds: readonly string[];
  readonly occurrences: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly detail: string;
  readonly rootCause: string | null;
  readonly fixReference: string | null;
}

export interface CampaignTaskRevision {
  readonly taskId: string;
  readonly revision: string;
}

export interface AdaptiveCampaignSelection {
  readonly selected: readonly RealTaskCase[];
  readonly reusedTaskIds: readonly string[];
  readonly duplicateTaskIds: readonly string[];
  readonly blockedFailureKeys: readonly string[];
  readonly scores: Readonly<Record<string, number>>;
}

const FailureTransitions: Readonly<
  Record<FailureResolutionState, readonly FailureResolutionState[]>
> = {
  open: ["diagnosed"],
  diagnosed: ["fixed"],
  fixed: ["fixed", "proving"],
  proving: ["fixed", "closed"],
  closed: ["open"],
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dimensionKeys(task: RealTaskCase): string[] {
  const coverage = task.coverage;
  return [
    `archetype:${coverage.archetype}`,
    ...coverage.dataShapes.map((value) => `data:${value}`),
    `risk:${coverage.risk}`,
    `lifecycle:${coverage.lifecycle}`,
    `path:${coverage.path}`,
    `interaction:${coverage.interaction}`,
    `model:${coverage.modelRequirement}`,
  ];
}

/** A semantic signature prevents differently worded copies from receiving extra coverage credit. */
export function realTaskSemanticSignature(task: RealTaskCase): string {
  const coverage = task.coverage;
  return [
    task.surface,
    coverage.capability,
    coverage.objective.trim().toLocaleLowerCase("en-US"),
    coverage.archetype,
    [...coverage.dataShapes].sort().join(","),
    coverage.risk,
    coverage.lifecycle,
    coverage.path,
    coverage.interaction,
    coverage.modelRequirement,
  ].join("|");
}

function currentEvidenceByTask(
  evidence: readonly CampaignEvidence[],
  revisions: ReadonlyMap<string, string>,
): Map<string, CampaignEvidence> {
  const result = new Map<string, CampaignEvidence>();
  for (const entry of evidence) {
    if (revisions.get(entry.taskId) !== entry.taskRevision) continue;
    const previous = result.get(entry.taskId);
    if (!previous || previous.updatedAt < entry.updatedAt)
      result.set(entry.taskId, entry);
  }
  return result;
}

/**
 * Selects the minimum useful next batch. Open/diagnosed failures halt new sampling; after a fix,
 * explicit proof tasks take priority. Current passing evidence is reused and semantic duplicates
 * are excluded rather than counted as extra confidence.
 */
export function selectAdaptiveCampaignTasks(input: {
  readonly cases: readonly RealTaskCase[];
  readonly revisions: readonly CampaignTaskRevision[];
  readonly evidence: readonly CampaignEvidence[];
  readonly failures: readonly CampaignFailureRecord[];
  readonly limit: number;
}): AdaptiveCampaignSelection {
  const revisions = new Map(
    input.revisions.map((entry) => [entry.taskId, entry.revision]),
  );
  if (revisions.size !== input.cases.length) {
    throw new Error("Every campaign task must have exactly one revision");
  }
  const ids = new Set(input.cases.map((task) => task.id));
  if (ids.size !== input.cases.length)
    throw new Error("Campaign task ids must be unique");
  for (const id of ids) {
    if (!revisions.has(id))
      throw new Error(`Campaign revision missing for task: ${id}`);
  }

  const blockedFailureKeys = input.failures
    .filter(
      (failure) => failure.state === "open" || failure.state === "diagnosed",
    )
    .map((failure) => failure.key)
    .sort();
  if (blockedFailureKeys.length > 0) return {
      selected: [],
      reusedTaskIds: [],
      duplicateTaskIds: [],
      blockedFailureKeys,
      scores: {},
    };

  const current = currentEvidenceByTask(input.evidence, revisions);
  const reusedTaskIds = [...current.values()]
    .filter((entry) => entry.outcome === "pass")
    .map((entry) => entry.taskId)
    .sort();
  const coveredDimensions = new Set(
    input.cases
      .filter((task) => current.get(task.id)?.outcome === "pass")
      .flatMap(dimensionKeys),
  );
  const provingTaskIds = new Set(
    input.failures
      .filter(
        (failure) => failure.state === "fixed" || failure.state === "proving",
      )
      .flatMap((failure) =>
        failure.proofTaskIds.filter(
          (taskId) => !failure.passedProofTaskIds.includes(taskId),
        ),
      ),
  );

  const duplicateTaskIds: string[] = [];
  const bySignature = new Map<string, RealTaskCase>();
  for (const task of input.cases) {
    const signature = realTaskSemanticSignature(task);
    const previous = bySignature.get(signature);
    if (!previous) {
      bySignature.set(signature, task);
      continue;
    }
    const keep =
      task.coverage.dailyWeight > previous.coverage.dailyWeight
        ? task
        : previous;
    const drop = keep === task ? previous : task;
    bySignature.set(signature, keep);
    duplicateTaskIds.push(drop.id);
  }

  const scores: Record<string, number> = {};
  const candidates = [...bySignature.values()].filter((task) => {
    if (provingTaskIds.has(task.id)) return true;
    return current.get(task.id)?.outcome !== "pass";
  });
  const selected: RealTaskCase[] = [];
  const selectionDimensions = new Set(coveredDimensions);
  while (selected.length < Math.max(0, input.limit) && candidates.length > 0) {
    for (const task of candidates) {
      const previous = current.get(task.id);
      const novelDimensions = dimensionKeys(task).filter(
        (dimension) => !selectionDimensions.has(dimension),
      ).length;
      scores[task.id] =
        (provingTaskIds.has(task.id) ? 10_000 : 0) +
        (previous?.outcome === "fail"
          ? 1_000
          : previous?.outcome === "void"
            ? 250
            : 500) +
        novelDimensions * 40 +
        task.coverage.dailyWeight * 10 +
        (task.coverage.path === "boundary" ||
        task.coverage.path === "failure-recovery"
          ? 20
          : 0);
    }
    candidates.sort(
      (left, right) =>
        (scores[right.id] ?? 0) - (scores[left.id] ?? 0) ||
        left.id.localeCompare(right.id),
    );
    const next = candidates.shift();
    if (!next) break;
    selected.push(next);
    dimensionKeys(next).forEach((dimension) =>
      selectionDimensions.add(dimension),
    );
  }

  return {
    selected,
    reusedTaskIds,
    duplicateTaskIds: duplicateTaskIds.sort(),
    blockedFailureKeys,
    scores,
  };
}

export function requiredProofCount(classification: RootCauseClass): number {
  return classification === "model" || classification === "runtime" ? 3 : 2;
}

export function recordCampaignFailure(input: {
  readonly failures: readonly CampaignFailureRecord[];
  readonly key: string;
  readonly classification: RootCauseClass;
  readonly capability: string;
  readonly taskId: string;
  readonly detail: string;
  readonly now: number;
}): CampaignFailureRecord[] {
  const existing = input.failures.find((failure) => failure.key === input.key);
  const next: CampaignFailureRecord = existing
    ? {
        ...existing,
        state: "open",
        affectedTaskIds: unique([...existing.affectedTaskIds, input.taskId]),
        occurrences: existing.occurrences + 1,
        lastSeenAt: input.now,
        detail: input.detail,
        passedProofTaskIds: [],
      }
    : {
        key: input.key,
        classification: input.classification,
        state: "open",
        capability: input.capability,
        affectedTaskIds: [input.taskId],
        proofTaskIds: [],
        passedProofTaskIds: [],
        occurrences: 1,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        detail: input.detail,
        rootCause: null,
        fixReference: null,
      };
  return [
    ...input.failures.filter((failure) => failure.key !== input.key),
    next,
  ].sort((left, right) => left.key.localeCompare(right.key));
}

export function transitionCampaignFailure(input: {
  readonly failure: CampaignFailureRecord;
  readonly state: FailureResolutionState;
  readonly classification?: RootCauseClass;
  readonly rootCause?: string | null;
  readonly fixReference?: string | null;
  readonly proofTaskIds?: readonly string[];
}): CampaignFailureRecord {
  if (!FailureTransitions[input.failure.state].includes(input.state)) {
    throw new Error(
      `Invalid failure transition: ${input.failure.state} -> ${input.state}`,
    );
  }
  if (input.state === "diagnosed" && !input.rootCause?.trim()) {
    throw new Error("Diagnosed failures require a root cause");
  }
  if (input.state === "fixed" && !input.fixReference?.trim()) {
    throw new Error("Fixed failures require a fix reference");
  }
  const classification = input.classification ?? input.failure.classification;
  const proofTaskIds = unique(input.proofTaskIds ?? input.failure.proofTaskIds);
  if (
    input.state === "fixed" &&
    proofTaskIds.length < requiredProofCount(classification)
  ) {
    throw new Error(
      `Fixed ${classification} failures require at least ${requiredProofCount(classification)} distinct proof tasks`,
    );
  }
  return {
    ...input.failure,
    classification,
    state: input.state,
    rootCause: input.rootCause?.trim() || input.failure.rootCause,
    fixReference: input.fixReference?.trim() || input.failure.fixReference,
    proofTaskIds,
    passedProofTaskIds:
      input.state === "fixed" ? [] : input.failure.passedProofTaskIds,
  };
}

export function recordCampaignProof(
  failure: CampaignFailureRecord,
  taskId: string,
): CampaignFailureRecord {
  if (failure.state !== "fixed" && failure.state !== "proving") return failure;
  if (!failure.proofTaskIds.includes(taskId)) return failure;
  const passedProofTaskIds = unique([...failure.passedProofTaskIds, taskId]);
  const enough =
    passedProofTaskIds.length >= requiredProofCount(failure.classification);
  return {
    ...failure,
    state: enough ? "closed" : "proving",
    passedProofTaskIds,
  };
}

/**
 * The campaign ledger is the proof authority. A notebook only caches which proof
 * tasks passed, so a task edit or runtime rebase must be able to revoke cached
 * proof without pretending that the underlying fix disappeared.
 */
export function reconcileCampaignProof(
  failure: CampaignFailureRecord,
  currentPassingTaskIds: ReadonlySet<string>,
): CampaignFailureRecord {
  if (failure.state === "open" || failure.state === "diagnosed") return failure.passedProofTaskIds.length === 0
      ? failure
      : { ...failure, passedProofTaskIds: [] };
  const passedProofTaskIds = failure.proofTaskIds.filter((taskId) =>
    currentPassingTaskIds.has(taskId),
  );
  const enough =
    passedProofTaskIds.length >= requiredProofCount(failure.classification);
  return {
    ...failure,
    state: enough
      ? "closed"
      : passedProofTaskIds.length > 0
        ? "proving"
        : "fixed",
    passedProofTaskIds,
  };
}
