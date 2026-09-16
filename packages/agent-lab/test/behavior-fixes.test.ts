import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { FullCapabilities, journey, observation, trial } from "../spec/support.js";
import type { JobSpec, LabDriver, RunArchive, VerifierRegistryApi } from "../src/exports/index.js";
import {
  createDetectorRegistry,
  createVerifierRegistry,
  journeyRunner,
  UnlimitedBudget,
} from "../src/exports/index.js";

function passingVerifiers(): VerifierRegistryApi {
  const verifiers = createVerifierRegistry();
  verifiers.register("complete", () => ({
    kind: "pass",
    credit: 1,
    evidence: {},
  }));
  return verifiers;
}

/** 每次 waitSettled 让假时钟走 `legMs`：用来把「本段用时」与「整程用时」分开。 */
function clockedDriver(clock: { value: number }, legMs: number): LabDriver {
  const session = {
    id: "session",
    executorId: "executor-a",
    externalId: "native",
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
    prepare: async () => undefined,
    send: async () => undefined,
    waitSettled: async (_session, request) => {
      clock.value += legMs;
      const decision = await request.onSample({
        observation: observation("running"),
        usage: {
          toolCalls: 0,
          workingMs: legMs,
          wallClockMs: legMs,
          tokens: 1,
          legs: 0,
        },
      });
      if (decision.kind === "abort")
        return {
          kind: "aborted",
          detectorId: decision.detectorId,
          reason: decision.reason,
        };
      return { kind: "settled" };
    },
    collect: async (_session, phase) => observation(phase),
    abort: async () => undefined,
    closeSession: async () => undefined,
  };
}

describe("归档里的 harness 版本", () => {
  test("缺省用本包真实版本，不再是写死的 0.1.0", async () => {
    const clock = { value: 1_000 };
    const result = await journeyRunner.runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial(),
      journey: journey(),
      driver: clockedDriver(clock, 10),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    });
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(result.manifest.harness.packageVersion).toBe(manifest.version);
    expect(result.manifest.harness.packageVersion).not.toBe("0.1.0");
  });
});

describe("段预算的口径", () => {
  test("第二段按本段用时判，不再被整程用时判成超预算", async () => {
    const clock = { value: 0 };
    const definition = journey("journey-a", 2);
    const [first, second] = definition.legs;
    const result = await journeyRunner.runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial(),
      journey: {
        ...definition,
        // 整程不限时；两段各跑 5 秒，第二段自己的上限是 8 秒。
        budget: { ...UnlimitedBudget, legs: 2 },
        legs: [
          first!,
          { ...second!, budget: { ...UnlimitedBudget, wallClockMs: 8_000 } },
        ],
      },
      driver: clockedDriver(clock, 5_000),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    });

    expect(result.legs).toHaveLength(2);
    expect(result.legs[1]?.settleOutcome.kind).toBe("settled");
    expect(result.manifest.exitReason).toBe("completed");
  });

  test("本段真的超了本段预算时照样判超", async () => {
    const clock = { value: 0 };
    const definition = journey("journey-a", 1);
    const [only] = definition.legs;
    const result = await journeyRunner.runJourney({
      jobId: "job",
      suiteId: "suite",
      trial: trial(),
      journey: {
        ...definition,
        budget: { ...UnlimitedBudget, legs: 1 },
        legs: [{ ...only!, budget: { ...UnlimitedBudget, wallClockMs: 1_000 } }],
      },
      driver: clockedDriver(clock, 5_000),
      detectors: createDetectorRegistry(),
      verifiers: passingVerifiers(),
      workspaceRoot: null,
      sourceCommit: null,
      consumerCommit: null,
      now: () => clock.value,
    });

    expect(result.legs[0]?.settleOutcome.kind).toBe("aborted");
  });
});

describe("runJob 的失败处理", () => {
  function jobWith(trialCount: number, concurrency: number): JobSpec {
    return {
      id: "job",
      suiteId: "suite",
      concurrency,
      archiveDirectory: "/archives",
      trials: Array.from({ length: trialCount }, (_, index) =>
        trial("executor-a", "journey-a", "group-a", index + 1),
      ),
    };
  }

  test("一个试验失败后不再派发新试验，也不在后台继续开会话", async () => {
    const started: string[] = [];
    const job = jobWith(6, 1);
    await expect(
      journeyRunner.runJob(job, {
        resolveDriver: (candidate) => {
          started.push(candidate.id);
          if (started.length === 2) throw new Error("driver unavailable");
          return clockedDriver({ value: 0 }, 1);
        },
        runTrial: async () => ({ manifest: { trial: { id: "x" } } }) as unknown as RunArchive,
      }),
    ).rejects.toThrow("driver unavailable");

    // 第二个试验失败后，剩下四个一个都没开始。
    expect(started).toHaveLength(2);
  });

  test("并发时等在飞的试验收尾再抛，不留后台会话", async () => {
    const finished: string[] = [];
    let releaseSlow: () => void = () => undefined;
    const slowTrial = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const job = jobWith(4, 2);

    const run = journeyRunner.runJob(job, {
      resolveDriver: (candidate) => {
        if (candidate.replicate.index === 2) throw new Error("boom");
        return clockedDriver({ value: 0 }, 1);
      },
      runTrial: async (candidate) => {
        if (candidate.replicate.index === 1) await slowTrial;
        finished.push(candidate.id);
        return { manifest: { trial: { id: candidate.id } } } as unknown as RunArchive;
      },
    });

    // 失败已经发生，但第一个试验还在飞：runJob 必须等它，而不是当场返回。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toHaveLength(0);
    releaseSlow();
    await expect(run).rejects.toThrow("boom");
    expect(finished).toEqual([job.trials[0]!.id]);
  });
});
