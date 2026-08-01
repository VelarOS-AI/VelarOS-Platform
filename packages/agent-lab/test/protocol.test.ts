import { describe, expect, test } from "bun:test";

import {
  parseJobSpec,
  parseJourneySpec,
  parseRunArchive,
} from "../src/protocol/index.js";

import { archive, journey, trial } from "./fixtures.js";

describe("public protocol", () => {
  test("accepts versioned continuous journeys and strict v3 archives", () => {
    expect(parseJourneySpec(journey("journey-a", 2)).legs).toHaveLength(2);
    expect(parseRunArchive(archive()).manifest.schema).toBe("agent-lab/run@3");
  });

  test("rejects duplicate leg and criterion identities", () => {
    const value = journey("journey-a", 2);
    expect(() =>
      parseJourneySpec({
        ...value,
        legs: [value.legs[0], { ...value.legs[1], id: value.legs[0].id }],
      }),
    ).toThrow("Duplicate leg id");
  });

  test("rejects invalid replicate identities", () => {
    const value = trial();
    expect(() =>
      parseJobSpec({
        id: "job",
        suiteId: "suite",
        concurrency: 1,
        archiveDirectory: "/tmp/runs",
        trials: [
          { ...value, replicate: { ...value.replicate, index: 3, ofK: 2 } },
        ],
      }),
    ).toThrow("Replicate index cannot exceed ofK");
  });

  test("does not coerce absent values into zero", () => {
    const original = archive();
    const value = {
      ...original,
      usage: null,
      manifest: {
        ...original.manifest,
        usage: { ...original.manifest.usage, tokens: null },
      },
    };
    expect(parseRunArchive(value).manifest.usage.tokens).toBeNull();
    expect(parseRunArchive(value).usage).toBeNull();
  });
});
