import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ContextRetrievalReferenceReader } from "../src/agent/context/retrieval/ReferenceReader";
import { chatSearchRanking } from "../src/agent/context/retrieval/search/Ranking";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

void test("preserves the authoritative tail across log sampling and display snippet budgets", async () => {
  const root = await mkdtemp(join(tmpdir(), "velaros-context-log-"));
  temporaryRoots.push(root);
  const path = join(root, "vela-system-command-head-tail.log");
  await writeFile(
    path,
    `${Array.from(
      { length: 400 },
      (_, index) => `event-${String(index + 1).padStart(3, "0")} payload`,
    ).join("\n")  }\n`,
  );

  const reader = new ContextRetrievalReferenceReader();
  const [log] = await reader.readReferencedLogs(
    [{ path, source: "serializedResult.logPath" }],
    800,
  );
  assert.equal(log?.truncated, true);
  assert.match(log?.content ?? "", /event-001/u);
  assert.match(log?.content ?? "", /event-400/u);

  const displaySnippet = chatSearchRanking.buildHeadTailSnippet(
    log?.content ?? "",
    300,
  );
  assert.match(displaySnippet ?? "", /event-001/u);
  assert.match(displaySnippet ?? "", /event-400/u);
});
