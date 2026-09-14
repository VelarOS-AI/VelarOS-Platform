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
    assert.equal(compacted.blocks, undefined);
    assert.deepEqual(compacted.__historyInputOmissions, [{ path: ['blocks'], jsonPath: '$.blocks', items: 101 }]);
    assert.equal(compacted.__toolReceivedFullInput, true);
  });

  test("labels long string compaction as history-only", () => {
    const compacted = compactToolInputForModel({ content: "x".repeat(1_000) });

    assert.equal(compacted.content, undefined);
    assert.deepEqual(compacted.__historyInputOmissions, [{ path: ['content'], jsonPath: '$.content', chars: 1_000 }]);
  });
});


test('repeated history compaction preserves the omitted operation count and original-input ref', () => {
  const args = { edits: Array.from({ length: 300 }, (_, index) => ({ index })) }
  const first = compactToolInputForModel(args, 'many-operations')
  assert.equal(first.edits, undefined)
  assert.deepEqual(first.__historyInputOmissions, [{ path: ['edits'], jsonPath: '$.edits', items: 300, ref: 'input:many-operations' }])
  assert.deepEqual(compactToolInputForModel(first, 'many-operations'), first)
})
