import { expect, test } from "bun:test";

import type { NativeExecutionState } from "../src/drivers/index.js";
import type { VelarHooksClient } from "../src/drivers/index.js";
import {
  createPollingDriver,
  createVelarHooksDriver,
} from "../src/drivers/index.js";
import { EmptyBudgetUsage, UnlimitedBudget } from "../src/protocol/index.js";

import { FullCapabilities, journey, observation, trial } from "./fixtures.js";

test.each(["observed-card-A", null])("velar hooks replies only with the observed confirmation identity: %p", async (confirmationId) => {
  const replies: Array<{ readonly confirmationId?: string }> = [];
  let reads = 0;
  const client = {
    command: async (input: { readonly kind?: string; readonly confirmationId?: string }) => {
      if (input.kind === "get_runtime_status") {
        reads++;
        return { ok: true, data: { hasPendingConfirmation: true, pendingConfirmation: { confirmationId } } };
      }
      if (input.kind === "resolve_confirmation") {
        replies.push(input);
        // 宿主已切到 B 时拒绝旧 A，driver 不能为同次回复重新查询并改投 B。
        return { ok: false, error: "confirmation changed to B" };
      }
      return { ok: true, data: {} };
    },
  } as unknown as VelarHooksClient;
  const driver = createVelarHooksDriver({
    id: "hooks", client, polling: { pollMs: 1 },
    identity: { executorId: "executor-a", adapterVersion: "1", cliVersion: null,
      provider: null, model: null, modelRevision: null, contextWindow: null,
      reasoningProfile: null, configuration: {} },
  });
  const session = await driver.openSession({ trial: trial(), journey: journey(), workspaceRoot: null });
  reads = 0;
  await expect(driver.waitSettled(session, {
    budget: { ...UnlimitedBudget, wallClockMs: 1_000 },
    signal: new AbortController().signal,
    onSample: async () => ({ kind: "continue" }),
  })).rejects.toThrow(confirmationId ? "confirmation changed to B" : "no confirmationId");
  expect(reads).toBe(1);
  expect(replies.map((reply) => reply.confirmationId)).toEqual(confirmationId ? [confirmationId] : []);
});

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

test("velar hooks driver preserves structured error-text tool result truth", async () => {
  const client = {
    command: async (input: { readonly kind?: string }) => {
      if (input.kind === "get_runtime_status")
        return { ok: true, data: { running: false, status: "completed" } };
      if (input.kind === "get_transcript")
        return { ok: true, data: { messages: [] } };
      if (input.kind === "get_debug")
        return {
          ok: true,
          data: {
            turns: [
              {
                id: "turn-1",
                messages: [
                  {
                    content: [
                      {
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName: "system:write",
                        input: { path: "/tmp/existing" },
                      },
                    ],
                  },
                  {
                    content: [
                      {
                        type: "tool-result",
                        toolCallId: "call-1",
                        output: {
                          type: "error-text",
                          value: "destination already exists",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      return { ok: true, data: {} };
    },
  } as unknown as VelarHooksClient;
  const driver = createVelarHooksDriver({
    id: "hooks",
    identity: {
      executorId: "executor-a",
      adapterVersion: "1",
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    },
    client,
  });
  const session = await driver.openSession({
    trial: trial(),
    journey: journey(),
    workspaceRoot: null,
  });
  const result = await driver.collect(session, "archive");
  expect(result.turns[0]?.toolCalls[0]?.isError).toBe(true);
});

test("velar hooks driver waits for coordinator pending work between model turns", async () => {
  const statuses = [
    { running: false },
    { running: true },
    { running: false, pendingPrompt: true },
    { running: false, pendingPrompt: true },
    { running: false, queuedInputs: 1 },
    { running: false, queuedInputs: 0 },
    { running: false, queuedInputs: 0 },
  ];
  let statusReads = 0;
  const client = {
    command: async (input: { readonly kind?: string }) => {
      if (input.kind === "get_runtime_status")
        return {
          ok: true,
          data: statuses[Math.min(statusReads++, statuses.length - 1)],
        };
      if (input.kind === "get_transcript")
        return { ok: true, data: { messages: [] } };
      if (input.kind === "get_debug") return { ok: true, data: { turns: [] } };
      return { ok: true, data: {} };
    },
  } as unknown as VelarHooksClient;
  const driver = createVelarHooksDriver({
    id: "hooks-coordinator-idle",
    identity: {
      executorId: "executor-a",
      adapterVersion: "1",
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    },
    client,
    polling: { pollMs: 1, settlePolls: 2 },
  });
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
  expect(statusReads).toBe(statuses.length);
});

test("velar hooks driver settles when a short execution ends between polls", async () => {
  const statuses = [
    { running: false, executionEventCount: 0 },
    { running: false, executionEventCount: 2 },
  ];
  let statusReads = 0;
  const client = {
    command: async (input: { readonly kind?: string }) => {
      if (input.kind === "get_runtime_status")
        return {
          ok: true,
          data: statuses[Math.min(statusReads++, statuses.length - 1)],
        };
      if (input.kind === "get_transcript")
        return { ok: true, data: { messages: [] } };
      if (input.kind === "get_debug") return { ok: true, data: { turns: [] } };
      return { ok: true, data: {} };
    },
  } as unknown as VelarHooksClient;
  const driver = createVelarHooksDriver({
    id: "hooks-short-execution",
    identity: {
      executorId: "executor-a",
      adapterVersion: "1",
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    },
    client,
    polling: { pollMs: 1, settlePolls: 1 },
  });
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
  expect(statusReads).toBe(3);
});

test("velar hooks driver keeps the full trace for a durable task session", async () => {
  const client = {
    command: async (input: { readonly kind?: string }) => {
      if (input.kind === "get_runtime_status")
        return { ok: true, data: { running: false, executionEventCount: 1 } };
      if (input.kind === "get_transcript")
        return { ok: true, data: { messages: [] } };
      if (input.kind === "get_debug")
        return {
          ok: true,
          data: {
            turns: [
              {
                id: "prior-turn",
                messages: [
                  {
                    content: [
                      {
                        type: "tool-call",
                        toolCallId: "prior-call",
                        toolName: "system:read",
                        input: { path: "/fixture/input.json" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      return { ok: true, data: {} };
    },
  } as unknown as VelarHooksClient;
  const driver = createVelarHooksDriver({
    id: "hooks-durable-session",
    identity: {
      executorId: "executor-a",
      adapterVersion: "1",
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    },
    client,
    observationScope: "session",
  });
  const session = await driver.openSession({
    trial: trial(),
    journey: journey(),
    workspaceRoot: null,
  });
  await driver.send(session, journey().legs[0]);
  const result = await driver.collect(session, "archive");

  expect(result.turns[0]?.toolCalls[0]?.name).toBe("system:read");
});

test("velar hooks driver restores a durable per-leg observation boundary", async () => {
  let includeCurrentTurn = false;
  const turn = (id: string, callId: string, name: string) => ({
    id,
    messages: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: callId,
            toolName: name,
            input: {},
          },
        ],
      },
    ],
  });
  const client = {
    command: async (input: { readonly kind?: string }) => {
      if (input.kind === "get_runtime_status")
        return { ok: true, data: { running: false, executionEventCount: 2 } };
      if (input.kind === "get_transcript")
        return { ok: true, data: { messages: [] } };
      if (input.kind === "get_debug")
        return {
          ok: true,
          data: {
            turns: [
              turn("prior-turn", "prior-call", "system:read"),
              ...(includeCurrentTurn
                ? [turn("current-turn", "current-call", "system:write")]
                : []),
            ],
          },
        };
      return { ok: true, data: {} };
    },
  } as unknown as VelarHooksClient;
  const driver = createVelarHooksDriver({
    id: "hooks-restored-boundary",
    identity: {
      executorId: "executor-a",
      adapterVersion: "1",
      cliVersion: null,
      provider: null,
      model: null,
      modelRevision: null,
      contextWindow: null,
      reasoningProfile: null,
      configuration: {},
    },
    client,
    observationScope: "leg",
  });
  const session = await driver.openSession({
    trial: trial(),
    journey: journey(),
    workspaceRoot: null,
  });
  const baseline = await driver.captureObservationBaseline(session);
  await driver.closeSession(session);
  driver.restoreObservationBaseline(session, baseline);
  includeCurrentTurn = true;

  const result = await driver.collect(session, "archive");

  expect(baseline.toolCallIds).toEqual(["prior-call"]);
  expect(
    result.turns.flatMap((item) => item.toolCalls.map((call) => call.name)),
  ).toEqual(["system:write"]);
});
