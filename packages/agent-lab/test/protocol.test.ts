import { describe, expect, test } from "bun:test";

import { archive, journey, trial } from "../spec/support.js";
import { labWire, RunArchiveSchemaId } from "../src/index.js";

describe("public protocol", () => {
  test("accepts versioned continuous journeys and strict v3 archives", () => {
    expect(labWire.parseJourney(journey("journey-a", 2)).legs).toHaveLength(2);
    expect(labWire.parseRunArchive(archive()).manifest.schema).toBe(RunArchiveSchemaId);
  });

  test("rejects duplicate leg and criterion identities", () => {
    const value = journey("journey-a", 2);
    expect(() =>
      labWire.parseJourney({
        ...value,
        legs: [value.legs[0], { ...value.legs[1], id: value.legs[0].id }],
      }),
    ).toThrow("段 id 重复");
  });

  test("rejects invalid replicate identities", () => {
    const value = trial();
    expect(() =>
      labWire.parseJob({
        id: "job",
        suiteId: "suite",
        concurrency: 1,
        archiveDirectory: "/tmp/runs",
        trials: [
          { ...value, replicate: { ...value.replicate, index: 3, ofK: 2 } },
        ],
      }),
    ).toThrow("重复试验的序号不能大于总次数");
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
    expect(labWire.parseRunArchive(value).manifest.usage.tokens).toBeNull();
    expect(labWire.parseRunArchive(value).usage).toBeNull();
  });
});
