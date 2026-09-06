import { describe, expect, test } from "bun:test";

import { chatSearchRanking } from "../src/agent/context/retrieval/search/Ranking";

function collectPathHints(text: string): string[] {
  return chatSearchRanking.rankContextText({
    query: "",
    terms: [],
    text,
  }).pathHints;
}

describe("context retrieval path hints", () => {
  for (const [source, expected] of [
    ["/workspace/project/src/index.ts", "/workspace/project/src/index.ts"],
    ["./packages/agent/src/index.ts", "./packages/agent/src/index.ts"],
    ["../shared/config.json", "../shared/config.json"],
    ["~/workspace/packages/ui", "~/workspace/packages/ui"],
    ["README.md", "readme.md"],
  ] as const) {
    test(`extracts the complete path token ${source}`, () => {
      expect(collectPathHints(source)).toEqual([expected]);
    });
  }

  test("requires an exact extension at the complete file token boundary", () => {
    expect(collectPathHints("file.json")).toEqual(["file.json"]);
    expect(collectPathHints("file.jsonl")).toEqual([]);
    expect(collectPathHints("file.js")).toEqual(["file.js"]);
    expect(collectPathHints("file.javascript")).toEqual([]);
    expect(collectPathHints("file.java")).toEqual(["file.java"]);
  });

  test("scans a long hyphen run in linear time without inventing a hint", () => {
    const malicious = "-".repeat(100_000);
    const startedAt = performance.now();

    expect(collectPathHints(malicious)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
