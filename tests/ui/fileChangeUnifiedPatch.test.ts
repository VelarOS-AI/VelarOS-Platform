import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildFileDiffSummaryFromUnifiedPatch } from '../../packages/ui/src/conversation/cards/fileChangeDiff'

const TwoHunkPatch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,4 @@',
  ' import { a } from "./a"',
  '-const b = 1',
  '+const b = 2',
  ' ',
  ' export { a }',
  '@@ -20,3 +20,4 @@ function tail() {',
  ' first',
  '+inserted',
  ' second',
  ' third',
  '\\ No newline at end of file',
  '',
].join('\n')

void describe('file change summary from a unified patch', () => {
  void test('numbers rows from the hunk headers and folds the gap between hunks', () => {
    const summary = buildFileDiffSummaryFromUnifiedPatch(TwoHunkPatch, {
      additions: 2,
      deletions: 1,
      binary: false,
    })

    assert.equal(summary.added, 2)
    assert.equal(summary.removed, 1)
    assert.deepEqual(
      summary.rows.map((row) => [row.kind, row.oldLineNumber, row.newLineNumber, row.text]),
      [
        ['context', 1, 1, 'import { a } from "./a"'],
        ['remove', 2, null, 'const b = 1'],
        ['add', null, 2, 'const b = 2'],
        ['context', 3, 3, ''],
        ['context', 4, 4, 'export { a }'],
        ['collapsed', null, null, ''],
        ['context', 20, 20, 'first'],
        ['add', null, 21, 'inserted'],
        ['context', 21, 22, 'second'],
        ['context', 22, 23, 'third'],
      ]
    )
    assert.equal(summary.rows[5]?.hiddenCount, 15)
  })

  void test('reads zero-length ranges of added and deleted files', () => {
    const created = buildFileDiffSummaryFromUnifiedPatch(
      ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'),
      { additions: 2, deletions: 0, binary: false }
    )
    assert.deepEqual(
      created.rows.map((row) => [row.kind, row.newLineNumber]),
      [
        ['add', 1],
        ['add', 2],
      ]
    )

    const deleted = buildFileDiffSummaryFromUnifiedPatch(
      ['--- a/old.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two'].join('\n'),
      { additions: 0, deletions: 2, binary: false }
    )
    assert.deepEqual(
      deleted.rows.map((row) => [row.kind, row.oldLineNumber]),
      [
        ['remove', 1],
        ['remove', 2],
      ]
    )
  })

  void test('falls back to the numstat counts when the patch was left out or the file is binary', () => {
    const omitted = buildFileDiffSummaryFromUnifiedPatch('', {
      additions: 1200,
      deletions: 30,
      binary: false,
    })
    assert.deepEqual(omitted, { added: 1200, removed: 30, rows: [] })

    const binary = buildFileDiffSummaryFromUnifiedPatch('', {
      additions: 0,
      deletions: 0,
      binary: true,
      binaryLabel: '二进制文件已更改',
    })
    assert.deepEqual(binary.rows.map((row) => row.text), ['二进制文件已更改'])
  })
})
