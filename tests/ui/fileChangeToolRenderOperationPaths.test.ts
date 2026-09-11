import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { collectProjectApplyPaths } from '../../packages/ui/src/conversation/tool-render/fileChange/FileChangeToolRender'

void describe('collectProjectApplyPaths falling back to project:edit operation paths', () => {
  void test('reads paths out of args.operations[].operation when the failed result carries no changedFiles', () => {
    const args = {
      operations: [
        {
          operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'x', newText: 'y' },
          reason: 'fix a',
        },
        {
          operation: { type: 'rename_file', from: 'src/old.ts', to: 'src/new.ts' },
          reason: 'rename',
        },
      ],
    }
    const failedResult = {
      error: 'tool_execution_failed',
      reason: '事务校验失败，未写入磁盘：tx_1',
      code: 'VALIDATION_FAILED',
    }

    assert.deepEqual(collectProjectApplyPaths(failedResult, args), [
      'src/a.ts',
      'src/old.ts',
      'src/new.ts',
    ])
  })

  void test('prefers result-derived paths over the args.operations fallback', () => {
    const args = {
      operations: [{ operation: { type: 'replace_text', path: 'src/a.ts' }, reason: 'fix' }],
    }
    const result = { changedFiles: ['src/b.ts'] }

    assert.deepEqual(collectProjectApplyPaths(result, args), ['src/b.ts', 'src/a.ts'])
  })

  void test('deduplicates a path present in both the result and the operations fallback', () => {
    const args = {
      operations: [{ operation: { type: 'replace_text', path: 'src/a.ts' }, reason: 'fix' }],
    }
    const result = { changedFiles: ['src/a.ts'] }

    assert.deepEqual(collectProjectApplyPaths(result, args), ['src/a.ts'])
  })

  void test('returns no paths when operations is absent or malformed', () => {
    assert.deepEqual(collectProjectApplyPaths(null, { operations: 'not-an-array' }), [])
    assert.deepEqual(collectProjectApplyPaths(null, { operations: [{ reason: 'no operation' }] }), [])
    assert.deepEqual(collectProjectApplyPaths(null, null), [])
  })
})
