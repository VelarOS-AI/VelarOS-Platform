import type {
  DriverCapabilities,
  JourneySpec,
  Observation,
  RunArchive,
  TrialSpec,
} from "../src/protocol/index.js";
import {
  createUnobservedObservation,
  ObservationFaces,
  UnlimitedBudget,
} from "../src/protocol/index.js";

export function journey(id = "journey-a", legs = 1): JourneySpec {
  return {
    id,
    version: 1,
    title: `Journey ${id}`,
    description: "A deterministic test journey",
    tags: ["test"],
    space: "project",
    budget: { ...UnlimitedBudget, wallClockMs: 10_000, legs },
    setup: null,
    gatingDetectorIds: [],
    legs: Array.from({ length: legs }, (_, index) => ({
      id: `leg-${index + 1}`,
      title: `Leg ${index + 1}`,
      prompt: `prompt ${index + 1}`,
      weight: 1,
      blocking: true,
      budget: null,
      continueOn: [],
      driverParameters: {},
      criteria: [
        {
          id: "complete",
          verifierId: "complete",
          parameters: {},
          weight: 1,
          gate: true,
        },
      ],
    })),
  };
}

export function trial(
  executorId = "executor-a",
  journeyId = "journey-a",
  groupId = "group-a",
  index = 1,
): TrialSpec {
  return {
    id: `${journeyId}:${executorId}:${index}`,
    journeyId,
    journeyVersion: 1,
    executorId,
    arm: null,
    replicate: { groupId, index, ofK: 2, seed: index },
  };
}

export const FullCapabilities: DriverCapabilities = {
  observes: Object.fromEntries(
    ObservationFaces.map((face) => [face, "full"]),
  ) as Record<(typeof ObservationFaces)[number], "full">,
  settleSignal: "custom",
  canApproveInline: true,
  canAbortMidRun: true,
  verifierIsolation: "separate",
  preservesNativeExecution: true,
};

export function observation(phase: Observation["phase"] = "idle"): Observation {
  return {
    ...createUnobservedObservation(phase),
    coverage: FullCapabilities.observes,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 15,
      costUsd: null,
    },
  };
}

export interface ArchiveOptions {
  readonly runId?: string;
  readonly executorId?: string;
  readonly journeyId?: string;
  readonly groupId?: string;
  readonly replicateIndex?: number;
  readonly score?: number | null;
  readonly drops?: RunArchive["drops"];
  readonly capabilities?: DriverCapabilities;
}

export function archive(options: ArchiveOptions = {}): RunArchive {
  const executorId = options.executorId ?? "executor-a";
  const journeyId = options.journeyId ?? "journey-a";
  const definition = journey(journeyId);
  const trialSpec = trial(
    executorId,
    journeyId,
    options.groupId ?? `group-${journeyId}`,
    options.replicateIndex ?? 1,
  );
  const score = options.score === undefined ? 1 : options.score;
  return {
    manifest: {
      schema: "agent-lab/run@3",
      runId:
        options.runId ??
        `${journeyId}-${executorId}-${trialSpec.replicate.index}`,
      jobId: "job-a",
      suiteId: "suite-a",
      trial: trialSpec,
      harness: {
        packageVersion: "0.1.0",
        sourceCommit: "platform-commit",
        consumerCommit: "consumer-commit",
        taskDigest: `task-${journeyId}`,
        detectorDigest: "detectors-a",
        policyDigest: "policy-a",
      },
      executor: {
        executorId,
        adapterVersion: "1",
        cliVersion: null,
        provider: null,
        model: null,
        modelRevision: null,
        contextWindow: null,
        reasoningProfile: null,
        configuration: {},
      },
      capabilities: options.capabilities ?? FullCapabilities,
      startedAt: 1,
      finishedAt: 2,
      exitReason: "completed",
      budget: definition.budget,
      usage: {
        toolCalls: 0,
        workingMs: null,
        wallClockMs: 1,
        tokens: 15,
        legs: 1,
      },
      measurementBasis: "unique-tool-call",
    },
    journey: definition,
    legs: [
      {
        legId: "leg-1",
        startedAt: 1,
        finishedAt: 2,
        settleOutcome: { kind: "settled" },
        criteria: [
          {
            criterionId: "complete",
            verifierId: "complete",
            outcome:
              score === null
                ? {
                    kind: "void",
                    cause: "verifier-unavailable",
                    detail: "unknown",
                    evidence: {},
                  }
                : score === 1
                  ? { kind: "pass", credit: 1, evidence: {} }
                  : {
                      kind: "fail",
                      credit: 0,
                      failureClass: "output-contract",
                      reason: "failed",
                      evidence: {},
                    },
            durationMs: 1,
          },
        ],
        observation: observation(),
        findings: [],
        score,
        passed: score === null ? null : score === 1,
      },
    ],
    findings: [],
    drops: options.drops ?? [],
    usage: observation().usage,
    context: null,
    artifacts: [],
    extensions: {},
  };
}
