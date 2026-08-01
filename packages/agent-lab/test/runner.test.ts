import { describe, expect, test } from "bun:test";

import { DetectorRegistry } from "../src/detect/index.js";
import type {
  LabDriver,
  ObservationPhase,
  SessionHandle,
} from "../src/protocol/index.js";
import { runJourney, VerifierRegistry } from "../src/runner/index.js";

import { FullCapabilities, journey, observation, trial } from "./fixtures.js";

function successfulDriver(prompts: string[], sessions: string[]): LabDriver {
  const session: SessionHandle = {
    id: "persistent-session",
    executorId: "executor-a",
    externalId: "native-session",
    metadata: {},
  };
  return {
    id: "fake",
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
    openSession: async () => session,
    prepare: async (value) => {
      sessions.push(value.id);
    },
    send: async (value, leg) => {
      sessions.push(value.id);
      prompts.push(leg.prompt);
    },
    waitSettled: async (value, request) => {
      sessions.push(value.id);
      await request.onSample({
        observation: observation("running"),
        usage: {
          toolCalls: 0,
          workingMs: 1,
          wallClockMs: 1,
          tokens: 15,
          legs: 0,
        },
      });
      return { kind: "settled" };
    },
    collect: async (_session, phase: ObservationPhase) => observation(phase),
    abort: async () => undefined,
    closeSession: async (value) => {
      sessions.push(value.id);
    },
  };
}

describe("continuous journey runner", () => {
  test("advances every leg through one persistent native session", async () => {
    const prompts: string[] = [];
    const sessions: string[] = [];
    const verifiers = new VerifierRegistry();
    verifiers.register("complete", () => ({
      kind: "pass",
      credit: 1,
      evidence: {},
    }));
    const result = await runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial("executor-a", "journey-a"),
      journey: journey("journey-a", 2),
      driver: successfulDriver(prompts, sessions),
      detectors: new DetectorRegistry(),
      verifiers,
      workspaceRoot: "/workspace",
      sourceCommit: "platform",
      consumerCommit: "consumer",
      createRunId: () => "run-a",
    });
    expect(prompts).toEqual(["prompt 1", "prompt 2"]);
    expect(new Set(sessions)).toEqual(new Set(["persistent-session"]));
    expect(result.legs).toHaveLength(2);
    expect(result.legs.every((leg) => leg.passed === true)).toBeTrue();
  });

  test("records environment setup failure as attrition instead of a zero score", async () => {
    const driver = successfulDriver([], []);
    driver.prepare = async () => {
      throw new Error("fixture unavailable");
    };
    const verifiers = new VerifierRegistry();
    verifiers.register("complete", () => ({
      kind: "pass",
      credit: 1,
      evidence: {},
    }));
    const result = await runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial(),
      journey: journey(),
      driver,
      detectors: new DetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      createRunId: () => "run-failed-setup",
    });
    expect(result.legs).toHaveLength(0);
    expect(result.drops[0]?.cause).toBe("environment-setup-failed");
    expect(result.manifest.exitReason).toBe("environment-setup-failed");
  });

  test("continues the same journey after an explicitly expected native abort", async () => {
    const definition = journey("journey-a", 2);
    const first = definition.legs[0]!;
    const driver = successfulDriver([], []);
    let waits = 0;
    driver.waitSettled = async () =>
      waits++ === 0
        ? {
            kind: "aborted",
            detectorId: "test-abort",
            reason: "expected interruption",
          }
        : { kind: "settled" };
    const verifiers = new VerifierRegistry();
    verifiers.register("complete", () => ({
      kind: "pass",
      credit: 1,
      evidence: {},
    }));
    const result = await runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial("executor-a", "journey-a"),
      journey: {
        ...definition,
        legs: [{ ...first, continueOn: ["aborted"] }, definition.legs[1]!],
      },
      driver,
      detectors: new DetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
    });
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0]?.settleOutcome.kind).toBe("aborted");
    expect(result.manifest.exitReason).toBe("completed");
  });

  test("records driver failures as harness attrition instead of rejecting the job", async () => {
    const driver = successfulDriver([], []);
    driver.send = async () => {
      throw new Error("hook command rejected");
    };
    const verifiers = new VerifierRegistry();
    verifiers.register("complete", () => ({
      kind: "pass",
      credit: 1,
      evidence: {},
    }));
    const result = await runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial(),
      journey: journey(),
      driver,
      detectors: new DetectorRegistry(),
      verifiers,
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
    });
    expect(result.manifest.exitReason).toBe("harness-failure");
    expect(result.legs[0]?.passed).toBeNull();
    expect(result.drops[0]?.cause).toBe("harness-failure");
  });
});
