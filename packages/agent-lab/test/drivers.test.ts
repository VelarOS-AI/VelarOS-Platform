import { expect, test } from "bun:test";

import type { NativeExecutionState } from "../src/drivers/index.js";
import { createPollingDriver } from "../src/drivers/index.js";
import { EmptyBudgetUsage, UnlimitedBudget } from "../src/protocol/index.js";

import { FullCapabilities, journey, observation, trial } from "./fixtures.js";

test("polling driver requires executor-native progress and stable idle", async () => {
  const states: NativeExecutionState[] = [
    {
      running: false,
      awaitingConfirmation: false,
      awaitingInput: false,
      revision: "old",
      usage: EmptyBudgetUsage,
      unavailable: null,
    },
    {
      running: true,
      awaitingConfirmation: false,
      awaitingInput: false,
      revision: "old",
      usage: EmptyBudgetUsage,
      unavailable: null,
    },
    {
      running: false,
      awaitingConfirmation: false,
      awaitingInput: false,
      revision: "new",
      usage: EmptyBudgetUsage,
      unavailable: null,
    },
    {
      running: false,
      awaitingConfirmation: false,
      awaitingInput: false,
      revision: "new",
      usage: EmptyBudgetUsage,
      unavailable: null,
    },
  ];
  let cursor = 0;
  const driver = createPollingDriver(
    {
      id: "native",
      capabilities: async () => FullCapabilities,
      identity: async () => ({
        executorId: "executor-a",
        adapterVersion: "1",
        cliVersion: null,
        provider: null,
        model: null,
        modelRevision: null,
        contextWindow: null,
        reasoningProfile: null,
        configuration: {},
      }),
      openSession: async () => ({
        id: "s",
        executorId: "executor-a",
        externalId: "native",
        metadata: {},
      }),
      prepare: async () => undefined,
      send: async () => undefined,
      readState: async () => states[Math.min(cursor++, states.length - 1)],
      collect: async (_session, phase) => observation(phase),
      abort: async () => undefined,
      closeSession: async () => undefined,
    },
    { pollMs: 1, settlePolls: 2, defaultWallClockMs: 1_000 },
  );
  const session = await driver.openSession({
    trial: trial(),
    journey: journey(),
    workspaceRoot: null,
  });
  await driver.send(session, journey().legs[0]);
  const outcome = await driver.waitSettled(session, {
    budget: { ...UnlimitedBudget, wallClockMs: 1_000 },
    signal: new AbortController().signal,
    onSample: async () => ({ kind: "continue" }),
  });
  expect(outcome.kind).toBe("settled");
});

test("polling driver classifies native executor unavailability as attrition", async () => {
  const driver = createPollingDriver(
    {
      id: "native-unavailable",
      capabilities: async () => FullCapabilities,
      identity: async () => ({
        executorId: "executor-a",
        adapterVersion: "1",
        cliVersion: null,
        provider: null,
        model: null,
        modelRevision: null,
        contextWindow: null,
        reasoningProfile: null,
        configuration: {},
      }),
      openSession: async () => ({
        id: "s",
        executorId: "executor-a",
        externalId: "native",
        metadata: {},
      }),
      prepare: async () => undefined,
      send: async () => undefined,
      readState: async () => ({
        running: false,
        awaitingConfirmation: false,
        awaitingInput: false,
        revision: "error",
        usage: EmptyBudgetUsage,
        unavailable: { detail: "authentication_failed" },
      }),
      collect: async (_session, phase) => observation(phase),
      abort: async () => undefined,
      closeSession: async () => undefined,
    },
    { pollMs: 1, settlePolls: 1, defaultWallClockMs: 1_000 },
  );
  const session = await driver.openSession({
    trial: trial(),
    journey: journey(),
    workspaceRoot: null,
  });
  const outcome = await driver.waitSettled(session, {
    budget: { ...UnlimitedBudget, wallClockMs: 1_000 },
    signal: new AbortController().signal,
    onSample: async () => ({ kind: "continue" }),
  });
  expect(outcome).toEqual({
    kind: "unavailable",
    cause: "agent-unavailable",
    detail: "authentication_failed",
  });
});
