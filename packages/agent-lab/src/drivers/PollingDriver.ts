import { setTimeout as delay } from "node:timers/promises";

import type {
  Budget,
  BudgetUsage,
  DriverCapabilities,
  ExecutorIdentity,
  JourneySetup,
  LabDriver,
  LegSpec,
  Observation,
  ObservationPhase,
  SessionHandle,
  SessionSpec,
  SettleOutcome,
  SettleRequest,
} from "../protocol/index.js";

export interface NativeExecutionState {
  readonly running: boolean;
  readonly awaitingConfirmation: boolean;
  readonly awaitingInput: boolean;
  /** Executor-native monotonic completion fence, such as a message id or process generation. */
  readonly revision: string | null;
  readonly usage: BudgetUsage;
  readonly unavailable: { readonly detail: string } | null;
}

export interface PollingDriverPolicy {
  readonly pollMs: number;
  readonly settlePolls: number;
  readonly defaultWallClockMs: number;
  readonly confirmation: "approve" | "reject" | "wait";
}

export interface PollingDriverAdapter {
  readonly id: string;
  capabilities(): Promise<DriverCapabilities>;
  identity(): Promise<ExecutorIdentity>;
  openSession(spec: SessionSpec): Promise<SessionHandle>;
  prepare(session: SessionHandle, setup: JourneySetup | null): Promise<void>;
  send(session: SessionHandle, leg: LegSpec): Promise<void>;
  readState(session: SessionHandle): Promise<NativeExecutionState>;
  collect(
    session: SessionHandle,
    phase: ObservationPhase,
  ): Promise<Observation>;
  resolveConfirmation?(
    session: SessionHandle,
    approved: boolean,
    rejectionMessage: string | null,
  ): Promise<void>;
  abort(session: SessionHandle, reason: string): Promise<void>;
  closeSession(session: SessionHandle): Promise<void>;
}

const DefaultPolicy = Object.freeze({
  pollMs: 2_500,
  settlePolls: 2,
  defaultWallClockMs: 240_000,
  confirmation: "approve",
}) satisfies PollingDriverPolicy;

function exceeded(usage: BudgetUsage, budget: Budget): keyof Budget | null {
  const fields = [
    "toolCalls",
    "workingMs",
    "wallClockMs",
    "tokens",
    "legs",
  ] as const;
  for (const field of fields) {
    const limit = budget[field];
    const consumed = usage[field];
    if (limit !== null && consumed !== null && consumed > limit) return field;
  }
  return null;
}

/**
 * Creates a driver whose adapter remains the authority for native execution state.
 * The shared loop only applies budgets, confirmation policy, stable-idle sampling, and watchdogs.
 */
export function createPollingDriver(
  adapter: PollingDriverAdapter,
  policy: Partial<PollingDriverPolicy> = {},
): LabDriver {
  const resolved = { ...DefaultPolicy, ...policy };
  const fences = new Map<string, string | null>();

  async function waitSettled(
    session: SessionHandle,
    request: SettleRequest,
  ): Promise<SettleOutcome> {
    const startedAt = Date.now();
    const wallClockLimit =
      request.budget.wallClockMs ?? resolved.defaultWallClockMs;
    const deadline = startedAt + wallClockLimit;
    const beforeRevision = fences.get(session.id) ?? null;
    let stablePolls = 0;
    let sawRunning = false;

    while (Date.now() <= deadline) {
      if (request.signal.aborted)
        return {
          kind: "unavailable",
          cause: "interrupted",
          detail: "Run signal aborted",
        };
      const state = await adapter.readState(session);
      if (state.unavailable)
        return {
          kind: "unavailable",
          cause: "agent-unavailable",
          detail: state.unavailable.detail,
        };
      sawRunning ||= state.running;

      if (state.awaitingConfirmation) {
        if (resolved.confirmation === "wait" || !adapter.resolveConfirmation)
          return { kind: "awaiting-input" };
        const approved = resolved.confirmation === "approve";
        await adapter.resolveConfirmation(
          session,
          approved,
          approved ? null : "Evaluation policy rejected this operation",
        );
        stablePolls = 0;
        try {
          await delay(resolved.pollMs, undefined, { signal: request.signal });
        } catch (error) {
          if (request.signal.aborted)
            return {
              kind: "unavailable",
              cause: "interrupted",
              detail: "Run signal aborted",
            };
          throw error;
        }
        continue;
      }
      if (state.awaitingInput) return { kind: "awaiting-input" };

      const observation = await adapter.collect(
        session,
        state.running ? "running" : "idle",
      );
      const usage: BudgetUsage = {
        ...state.usage,
        wallClockMs: Math.max(
          state.usage.wallClockMs ?? 0,
          Date.now() - startedAt,
        ),
      };
      const decision = await request.onSample({ observation, usage });
      if (decision.kind === "abort")
        return {
          kind: "aborted",
          detectorId: decision.detectorId,
          reason: decision.reason,
        };
      const budgetLimit = exceeded(usage, request.budget);
      if (budgetLimit) return { kind: "budget-exhausted", limit: budgetLimit };

      const revisionAdvanced =
        state.revision !== null && state.revision !== beforeRevision;
      const completed = !state.running && (revisionAdvanced || sawRunning);
      stablePolls = completed ? stablePolls + 1 : 0;
      if (stablePolls >= Math.max(1, resolved.settlePolls)) {
        fences.set(session.id, state.revision);
        return { kind: "settled" };
      }
      try {
        await delay(resolved.pollMs, undefined, { signal: request.signal });
      } catch (error) {
        if (request.signal.aborted)
          return {
            kind: "unavailable",
            cause: "interrupted",
            detail: "Run signal aborted",
          };
        throw error;
      }
    }
    return { kind: "timeout" };
  }

  return {
    id: adapter.id,
    capabilities: () => adapter.capabilities(),
    identity: () => adapter.identity(),
    openSession: async (spec) => {
      const session = await adapter.openSession(spec);
      const initial = await adapter.readState(session);
      fences.set(session.id, initial.revision);
      return session;
    },
    prepare: (session, setup) => adapter.prepare(session, setup),
    send: (session, leg) => adapter.send(session, leg),
    waitSettled,
    collect: (session, phase) => adapter.collect(session, phase),
    abort: (session, reason) => adapter.abort(session, reason),
    closeSession: async (session) => {
      fences.delete(session.id);
      await adapter.closeSession(session);
    },
  };
}
