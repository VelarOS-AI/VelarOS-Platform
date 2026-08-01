import { describe, expect, test } from "bun:test";

import {
  certifySubject,
  parseCertificationPolicy,
  parseCertificationSubject,
} from "../src/certification/index.js";
import { ObservationFaces } from "../src/protocol/index.js";
import {
  checkComparability,
  compareExecutors,
  estimateReliability,
} from "../src/statistics/index.js";

import { archive, FullCapabilities } from "./fixtures.js";

describe("statistics and certification", () => {
  test("strictly validates public certification inputs", () => {
    expect(
      parseCertificationSubject({
        kind: "mod",
        id: "example-mod",
        version: "1.0.0",
        digest: "a".repeat(64),
      }).id,
    ).toBe("example-mod");
    expect(() =>
      parseCertificationPolicy({
        id: "policy",
        version: 1,
        requiredJourneyIds: ["journey-a"],
        minimumReplicatesPerJourney: 3,
        minimumReliability: 1.5,
        maximumAttritionRate: 0.05,
        requiredObservationCoverage: { transcript: "full" },
        requireSeparateVerifier: true,
        requireNativeExecution: true,
        requireBaseline: false,
        maximumBaselineRegression: 0.02,
      }),
    ).toThrow();
  });
  test("uses paired journey clusters and refuses false precision with one cluster", () => {
    const oneCluster = [
      archive({ executorId: "a", journeyId: "j1", groupId: "g1", score: 1 }),
      archive({ executorId: "b", journeyId: "j1", groupId: "g1", score: 0 }),
    ];
    const one = compareExecutors(oneCluster, "a", "b");
    expect(one.completionDifference.estimate).toBe(1);
    expect(one.completionDifference.lower95).toBeNull();
    expect(one.decision).toBe("inconclusive");

    const two = compareExecutors(
      [
        ...oneCluster,
        archive({ executorId: "a", journeyId: "j2", groupId: "g2", score: 1 }),
        archive({ executorId: "b", journeyId: "j2", groupId: "g2", score: 0 }),
      ],
      "a",
      "b",
      { bootstrapSamples: 500, seed: 7 },
    );
    expect(two.clusters).toBe(2);
    expect(two.decision).toBe("a-better");
  });

  test("separates attrition from reliability denominator and enforces comparability", () => {
    const dropped = archive({
      runId: "dropped",
      drops: [
        {
          trialId: "t",
          legId: null,
          cause: "environment-drift",
          detail: "changed",
        },
      ],
    });
    const reliability = estimateReliability([archive(), dropped]);
    expect(reliability.attempts).toBe(1);
    expect(reliability.dropped).toBe(1);
    const original = archive({ runId: "drifted" });
    const drifted = {
      ...original,
      manifest: {
        ...original.manifest,
        budget: { ...original.manifest.budget, tokens: 99 },
      },
    };
    expect(checkComparability([archive(), drifted]).comparable).toBeFalse();
  });

  test("certifies only observed evidence and marks missing faces inconclusive", () => {
    const policy = {
      id: "policy",
      version: 1,
      requiredJourneyIds: ["journey-a"],
      minimumReplicatesPerJourney: 1,
      minimumReliability: 0,
      maximumAttritionRate: 0,
      requiredObservationCoverage: { artifacts: "full" as const },
      requireSeparateVerifier: true,
      requireNativeExecution: true,
      requireBaseline: false,
      maximumBaselineRegression: 0.05,
    };
    const subject = {
      kind: "agent" as const,
      id: "a",
      version: "1",
      digest: "digest",
    };
    expect(
      certifySubject({
        subject,
        policy,
        archives: [archive()],
        subjectExecutorId: "executor-a",
        now: () => 1,
      }).status,
    ).toBe("certified");

    const noArtifacts = {
      ...FullCapabilities,
      observes: Object.fromEntries(
        ObservationFaces.map((face) => [
          face,
          face === "artifacts" ? "none" : "full",
        ]),
      ) as typeof FullCapabilities.observes,
    };
    expect(
      certifySubject({
        subject,
        policy,
        archives: [archive({ capabilities: noArtifacts })],
        subjectExecutorId: "executor-a",
        now: () => 1,
      }).status,
    ).toBe("inconclusive");
  });
});
