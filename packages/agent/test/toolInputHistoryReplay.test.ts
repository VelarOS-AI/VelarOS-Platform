import assert from "node:assert/strict";

import { describe, test } from "bun:test";

import { compactToolInputForModel } from "../src/tools/toolResultSerialization";

describe("tool input provider-history replay", () => {
  test("keeps ordinary structured document blocks intact", () => {
    const blocks = Array.from({ length: 16 }, (_, index) => ({
      kind: "paragraph",
      text: `section ${index + 1}`,
    }));

    const compacted = compactToolInputForModel({
      outputPath: "brief.docx",
      blocks,
    });

    assert.deepEqual(compacted.blocks, blocks);
  });

  test("distinguishes a history preview from the input received by the tool", () => {
    const compacted = compactToolInputForModel({
      blocks: Array.from({ length: 101 }, (_, index) => ({ index })),
    });
    const blocks = compacted.blocks as Array<Record<string, unknown>>;
    const marker = blocks.at(-1);

    assert.equal(marker?.__historyPreviewOmittedItems, 1);
    assert.equal(marker?.__toolReceivedFullInput, true);
    assert.equal("__truncatedItems" in (marker ?? {}), false);
  });

  test("labels long string compaction as history-only", () => {
    const compacted = compactToolInputForModel({ content: "x".repeat(1_000) });

    assert.match(String(compacted.content), /history preview omitted/u);
    assert.match(String(compacted.content), /tool received the full value/u);
  });
});
