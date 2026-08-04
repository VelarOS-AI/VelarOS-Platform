import { randomUUID } from "node:crypto";

import {
  createWatchdogBaseline,
  type DetectorRegistry,
  normalizeObservation,
  selectAbortCandidate,
} from "../detect/index.js";
import type {
  ArtifactReference,
  Budget,
  ContextResidencyEvent,
  CriterionResult,
  DriverCapabilities,
  DropRecord,
  ExecutorIdentity,
  Finding,
  HarnessIdentity,
  LabDriver,
  LegResult,
  LegSpec,
  Observation,
  RunArchive,
  SessionHandle,
  SettleOutcome,
  TrialSpec,
  UsageAccount,
  VerificationOutcome,
} from "../protocol/index.js";
import {
  createUnobservedObservation,
  parseJourneySpec,
} from "../protocol/index.js";

import { BudgetLedger, resolveBudget } from "./BudgetLedger.js";
import { sha256Json } from "./Digests.js";
import { type VerifierRegistry } from "./VerifierRegistry.js";

export interface RunJourneyOptions {
  readonly jobId: string;
  readonly suiteId: string;
  readonly trial: TrialSpec;
  readonly journey: unknown;
  readonly driver: LabDriver;
  readonly detectors: DetectorRegistry;
  readonly verifiers: VerifierRegistry;
  readonly workspaceRoot: string | null;
  readonly sourceCommit: string | null;
  readonly consumerCommit: string | null;
  readonly packageVersion?: string;
  readonly now?: () => number;
  readonly createRunId?: () => string;
}

interface ExecutionState {
  readonly capabilities: DriverCapabilities;
  readonly executor: ExecutorIdentity;
  readonly session: SessionHandle | null;
  readonly startedAt: number;
}

function voidOutcome(
  cause: DropRecord["cause"],
  detail: string,
): VerificationOutcome {
  return { kind: "void", cause, detail, evidence: {} };
}

function settleOutcomeToVerification(
  outcome: SettleOutcome,
): VerificationOutcome | null {
  if (outcome.kind === "settled" || outcome.kind === "awaiting-input")
    return null;
  if (outcome.kind === "unavailable")
    return voidOutcome(outcome.cause, outcome.detail);
  if (outcome.kind === "timeout")
    return {
      kind: "fail",
      credit: 0,
      failureClass: "timeout",
      reason: "Executor did not settle before the time limit",
      evidence: {},
    };
  if (outcome.kind === "budget-exhausted")
    return {
      kind: "fail",
      credit: 0,
      failureClass: "budget-exhausted",
      reason: `Budget exhausted: ${outcome.limit}`,
      evidence: { limit: outcome.limit },
    };
  return {
    kind: "fail",
    credit: 0,
    failureClass: "loop",
    reason: outcome.reason,
    evidence: { detectorId: outcome.detectorId },
  };
}

function scoreCriteria(
  leg: LegSpec,
  criteria: readonly CriterionResult[],
): { readonly score: number | null; readonly passed: boolean | null } {
  let weightedCredit = 0;
  let weight = 0;
  let hasVoidGate = false;
  let gateFailed = false;
  for (const result of criteria) {
    const criterion = leg.criteria.find(
      (item) => item.id === result.criterionId,
    )!;
    if (result.outcome.kind === "void") {
      if (criterion.gate) hasVoidGate = true;
      continue;
    }
    weightedCredit += result.outcome.credit * criterion.weight;
    weight += criterion.weight;
    if (criterion.gate && result.outcome.kind !== "pass") gateFailed = true;
  }
  const score = weight > 0 ? weightedCredit / weight : null;
  const passed = hasVoidGate ? null : !gateFailed;
  return { score, passed };
}

function mergeUsage(legs: readonly LegResult[]): UsageAccount | null {
  const observed = legs
    .map((leg) => leg.observation.usage)
    .filter((usage) => usage !== null);
  if (observed.length === 0) return null;
  const latest = observed.at(-1)!;
  return { ...latest };
}

function contextAccount(legs: readonly LegResult[]): RunArchive["context"] {
  const observations = legs.map((leg) => leg.observation);
  const hasContext = observations.some(
    (observation) => observation.coverage["context-residency"] !== "none",
  );
  if (!hasContext) return null;
  const events = new Map<string, ContextResidencyEvent>();
  let peakTokens: number | null = null;
  let windowLimit: number | null = null;
  for (const observation of observations) {
    for (const event of observation.contextResidency)
      events.set(event.id, event);
    const tokens = observation.runtime?.contextTokens ?? null;
    if (tokens !== null) peakTokens = Math.max(peakTokens ?? 0, tokens);
    const window = observation.runtime?.contextWindow ?? null;
    if (window !== null) windowLimit = window;
  }
  return {
    peakTokens,
    windowLimit,
    epochs: [...events.values()].sort(
      (left, right) =>
        left.epoch - right.epoch || left.id.localeCompare(right.id),
    ),
  };
}

function artifactList(
  legs: readonly LegResult[],
): readonly ArtifactReference[] {
  const artifacts = new Map<string, ArtifactReference>();
  for (const leg of legs) {
    for (const artifact of leg.observation.artifacts)
      artifacts.set(artifact.id, artifact);
  }
  return [...artifacts.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function harnessIdentity(
  options: RunJourneyOptions,
  taskDigest: string,
  detectorDigest: string,
  policyDigest: string,
): HarnessIdentity {
  return {
    packageVersion: options.packageVersion ?? "0.1.0",
    sourceCommit: options.sourceCommit,
    consumerCommit: options.consumerCommit,
    taskDigest,
    detectorDigest,
    policyDigest,
  };
}

function validateBindings(
  options: RunJourneyOptions,
  journey: ReturnType<typeof parseJourneySpec>,
  leg: LegSpec,
): void {
  for (const detectorId of journey.gatingDetectorIds) {
    if (!options.detectors.get(detectorId)) {
      throw new Error(`Journey references unknown detector: ${detectorId}`);
    }
  }
  for (const criterion of leg.criteria) {
    if (!options.verifiers.get(criterion.verifierId)) {
      throw new Error(
        `Journey references unknown verifier: ${criterion.verifierId}`,
      );
    }
  }
}

async function verifyLeg(
  options: RunJourneyOptions,
  leg: LegSpec,
  state: ExecutionState,
  observation: Observation,
  settleOutcome: SettleOutcome,
  now: () => number,
): Promise<readonly CriterionResult[]> {
  const sharedOutcome = leg.continueOn.includes(
    settleOutcome.kind as Exclude<SettleOutcome["kind"], "settled">,
  )
    ? null
    : settleOutcomeToVerification(settleOutcome);
  const results: CriterionResult[] = [];
  for (const criterion of leg.criteria) {
    const startedAt = now();
    let outcome: VerificationOutcome;
    if (sharedOutcome) {
      outcome = sharedOutcome;
    } else {
      const verifier = options.verifiers.get(criterion.verifierId)!;
      try {
        outcome = await verifier({
          trial: options.trial,
          journey: parseJourneySpec(options.journey),
          leg,
          criterion,
          session: state.session!,
          observation,
          workspaceRoot:
            typeof state.session?.metadata.workspaceRoot === "string"
              ? state.session.metadata.workspaceRoot
              : options.workspaceRoot,
        });
      } catch (error) {
        outcome = {
          kind: "fail",
          credit: 0,
          failureClass: "verifier-failure",
          reason: error instanceof Error ? error.message : String(error),
          evidence: {},
        };
      }
    }
    results.push({
      criterionId: criterion.id,
      verifierId: criterion.verifierId,
      outcome,
      durationMs: Math.max(0, now() - startedAt),
    });
  }
  return results;
}

function dropRecords(
  trialId: string,
  legId: string,
  criteria: readonly CriterionResult[],
): readonly DropRecord[] {
  const unique = new Map<string, DropRecord>();
  for (const criterion of criteria) {
    if (criterion.outcome.kind !== "void") continue;
    const record = {
      trialId,
      legId,
      cause: criterion.outcome.cause,
      detail: criterion.outcome.detail,
    } satisfies DropRecord;
    unique.set(`${record.cause}\0${record.detail}`, record);
  }
  return [...unique.values()];
}

export async function runJourney(
  options: RunJourneyOptions,
): Promise<RunArchive> {
  const journey = parseJourneySpec(options.journey);
  if (
    options.trial.journeyId !== journey.id ||
    options.trial.journeyVersion !== journey.version
  ) {
    throw new Error(
      "Trial journey identity does not match the journey definition",
    );
  }
  for (const leg of journey.legs) validateBindings(options, journey, leg);

  const now = options.now ?? Date.now;
  const runId = (options.createRunId ?? randomUUID)();
  const startedAt = now();
  let preflightFailure: string | null = null;
  const capabilities = await options.driver
    .capabilities()
    .catch((error: unknown) => {
      preflightFailure = error instanceof Error ? error.message : String(error);
      return {
        observes: {
          artifacts: "none",
          "context-residency": "none",
          runtime: "none",
          transcript: "none",
          turns: "none",
          usage: "none",
          verifier: "none",
        },
        settleSignal: "custom",
        canApproveInline: false,
        canAbortMidRun: false,
        verifierIsolation: "none",
        preservesNativeExecution: false,
      } satisfies DriverCapabilities;
    });
  const executor = await options.driver.identity().catch((error: unknown) => {
    preflightFailure ??= error instanceof Error ? error.message : String(error);
    return {
      executorId: options.trial.executorId,
      adapterVersion: "unavailable",
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    } satisfies ExecutorIdentity;
  });
  const taskDigest = sha256Json(journey);
  const detectorDigest = sha256Json(
    options.detectors.list().map((item) => item.definition),
  );
  const policyDigest = sha256Json({
    budget: journey.budget,
    gatingDetectorIds: journey.gatingDetectorIds,
  });
  const ledger = new BudgetLedger(now, startedAt);
  const legResults: LegResult[] = [];
  const findings: Finding[] = [];
  const drops: DropRecord[] = [];
  let exitReason = "completed";
  let session: SessionHandle | null = null;
  let environmentReady = false;

  if (preflightFailure) {
    drops.push({
      trialId: options.trial.id,
      legId: null,
      cause: "agent-unavailable",
      detail: preflightFailure,
    });
    exitReason = "agent-unavailable";
  } else
    try {
      session = await options.driver.openSession({
        trial: options.trial,
        journey,
        workspaceRoot: options.workspaceRoot,
      });
      await options.driver.prepare(session, journey.setup);
      environmentReady = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      drops.push({
        trialId: options.trial.id,
        legId: null,
        cause: "environment-setup-failed",
        detail,
      });
      exitReason = "environment-setup-failed";
    }

  const state: ExecutionState = { capabilities, executor, session, startedAt };
  if (session && environmentReady) {
    try {
      for (const leg of journey.legs) {
        try {
          const legStartedAt = now();
          const legBudget: Budget = resolveBudget(journey.budget, leg.budget);
          let watchdogBaseline: ReturnType<
            typeof createWatchdogBaseline
          > | null = null;
          const watchdogAbort: {
            current: {
              readonly detectorId: string;
              readonly reason: string;
            } | null;
          } = { current: null };
          const activeWatchdogDetectorIds = new Set(
            journey.gatingDetectorIds,
          );

          await options.driver.send(session, leg);
          let settleOutcome = await options.driver.waitSettled(session, {
            budget: legBudget,
            signal: new AbortController().signal,
            onSample: async (sample) => {
              const observation = normalizeObservation(sample.observation);
              ledger.observe(observation);
              ledger.observeDriverUsage(sample.usage);
              const sampleFindings = options.detectors.detect(observation, {
                trial: options.trial,
                journey,
                leg,
              });
              const budgetLimit = ledger.exceeded(legBudget);
              if (budgetLimit) {
                watchdogAbort.current = {
                  detectorId: "budget-exhausted",
                  reason: `Budget exhausted: ${budgetLimit}`,
                };
                if (capabilities.canAbortMidRun) {
                  await options.driver.abort(
                    session!,
                    watchdogAbort.current.reason,
                  );
                }
                return { kind: "abort", ...watchdogAbort.current };
              }
              if (!watchdogBaseline) {
                watchdogBaseline = createWatchdogBaseline(
                  observation,
                  sampleFindings,
                  activeWatchdogDetectorIds,
                );
                return { kind: "continue" };
              }
              const candidate = selectAbortCandidate(
                observation,
                sampleFindings,
                watchdogBaseline,
                activeWatchdogDetectorIds,
              );
              if (!candidate) return { kind: "continue" };
              watchdogAbort.current = {
                detectorId: candidate.detectorId,
                reason: candidate.reason,
              };
              if (capabilities.canAbortMidRun) {
                await options.driver.abort(session!, candidate.reason);
              }
              return { kind: "abort", ...watchdogAbort.current };
            },
          });

          if (watchdogAbort.current && settleOutcome.kind === "settled") {
            settleOutcome = {
              kind: "aborted",
              detectorId: watchdogAbort.current.detectorId,
              reason: watchdogAbort.current.reason,
            };
          }
          const observation = normalizeObservation(
            await options.driver.collect(session, "idle"),
          );
          ledger.observe(observation);
          const legFindings = options.detectors.detect(observation, {
            trial: options.trial,
            journey,
            leg,
          });
          const gatingFinding = legFindings.some(
            (item) =>
              item.severity === "fail" &&
              journey.gatingDetectorIds.includes(item.detectorId),
          );
          const criteria = await verifyLeg(
            options,
            leg,
            state,
            observation,
            settleOutcome,
            now,
          );
          const score = scoreCriteria(leg, criteria);
          ledger.finishLeg();
          const result: LegResult = {
            legId: leg.id,
            startedAt: legStartedAt,
            finishedAt: now(),
            settleOutcome,
            criteria,
            observation,
            findings: legFindings,
            score: score.score,
            passed: gatingFinding ? false : score.passed,
          };
          legResults.push(result);
          findings.push(...legFindings);
          drops.push(...dropRecords(options.trial.id, leg.id, criteria));

          const blockingFailure =
            leg.blocking && (score.passed === false || gatingFinding);
          const expectedNativeOutcome =
            settleOutcome.kind !== "settled" &&
            leg.continueOn.includes(settleOutcome.kind);
          if (
            blockingFailure ||
            (settleOutcome.kind !== "settled" && !expectedNativeOutcome)
          ) {
            exitReason =
              settleOutcome.kind === "settled"
                ? "blocking-leg-failed"
                : settleOutcome.kind;
            break;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const observation = createUnobservedObservation("idle");
          const settleOutcome: SettleOutcome = {
            kind: "unavailable",
            cause: "harness-failure",
            detail,
          };
          const criteria = await verifyLeg(
            options,
            leg,
            state,
            observation,
            settleOutcome,
            now,
          );
          ledger.finishLeg();
          legResults.push({
            legId: leg.id,
            startedAt: now(),
            finishedAt: now(),
            settleOutcome,
            criteria,
            observation,
            findings: [],
            score: null,
            passed: null,
          });
          drops.push(...dropRecords(options.trial.id, leg.id, criteria));
          findings.push({
            detectorId: "driver-execution-failed",
            severity: "warn",
            failureClass: "infrastructure",
            summary: detail,
            references: [],
            evidence: {},
          });
          exitReason = "harness-failure";
          break;
        }
      }
    } finally {
      try {
        await options.driver.closeSession(session);
      } catch (error) {
        findings.push({
          detectorId: "session-close-failed",
          severity: "warn",
          failureClass: "infrastructure",
          summary: error instanceof Error ? error.message : String(error),
          references: [],
          evidence: {},
        });
        if (exitReason === "completed")
          exitReason = "completed-with-close-warning";
      }
    }
  } else if (session) {
    try {
      await options.driver.closeSession(session);
    } catch (error) {
      findings.push({
        detectorId: "session-close-failed",
        severity: "warn",
        failureClass: "infrastructure",
        summary: error instanceof Error ? error.message : String(error),
        references: [],
        evidence: {},
      });
    }
  }

  const finalExecutor = await options.driver.identity().catch((error: unknown) => {
    findings.push({
      detectorId: "executor-identity-refresh-failed",
      severity: "warn",
      failureClass: "infrastructure",
      summary: error instanceof Error ? error.message : String(error),
      references: [],
      evidence: {},
    });
    return executor;
  });
  const finishedAt = now();
  return {
    manifest: {
      schema: "agent-lab/run@3",
      runId,
      jobId: options.jobId,
      suiteId: options.suiteId,
      trial: options.trial,
      harness: harnessIdentity(
        options,
        taskDigest,
        detectorDigest,
        policyDigest,
      ),
      executor: finalExecutor,
      capabilities,
      startedAt,
      finishedAt,
      exitReason,
      budget: journey.budget,
      usage: ledger.snapshot(),
      measurementBasis: "unique-tool-call",
    },
    journey,
    legs: legResults,
    findings,
    drops,
    usage: mergeUsage(legResults),
    context: contextAccount(legResults),
    artifacts: artifactList(legResults),
    extensions: {},
  };
}
