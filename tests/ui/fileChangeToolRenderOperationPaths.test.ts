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

  void test('ignores the args.operations fallback entirely once the result carries any path', () => {
    // 参数路径未经规范化，结果侧路径已规范化；一旦结果侧有路径就应该只信任结果侧，
    // 否则同一个文件的两种写法会被当成两条并存（回归复现见下面两个用例）。
    const args = {
      operations: [{ operation: { type: 'replace_text', path: 'src/a.ts' }, reason: 'fix' }],
    }
    const result = { changedFiles: ['src/b.ts'] }

    assert.deepEqual(collectProjectApplyPaths(result, args), ['src/b.ts'])
  })

  void test('does not duplicate a successful edit whose args path is an unnormalized form of the result path', () => {
    const args = {
      operations: [{ operation: { type: 'replace_text', path: './note.txt' }, reason: 'fix' }],
    }
    const result = { changedFiles: ['note.txt'] }

    assert.deepEqual(collectProjectApplyPaths(result, args), ['note.txt'])
  })

  void test('does not duplicate a successful edit whose args path is absolute while the result path is workspace-relative', () => {
    const args = {
      operations: [
        { operation: { type: 'replace_text', path: '/private/tmp/root/note.txt' }, reason: 'fix' },
      ],
    }
    const result = { changedFiles: ['note.txt'] }

    assert.deepEqual(collectProjectApplyPaths(result, args), ['note.txt'])
  })

  void test('returns no paths when operations is absent or malformed', () => {
    assert.deepEqual(collectProjectApplyPaths(null, { operations: 'not-an-array' }), [])
    assert.deepEqual(collectProjectApplyPaths(null, { operations: [{ reason: 'no operation' }] }), [])
    assert.deepEqual(collectProjectApplyPaths(null, null), [])
  })
})
