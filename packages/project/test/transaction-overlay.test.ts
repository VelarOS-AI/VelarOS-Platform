import { describe, expect, test } from 'bun:test'

import {
  isCreatePatch,
  isDeletePatch,
  stagedContentAfter,
  TransactionOverlay,
  withoutStagedOffsets,
} from '../src/core/transaction-overlay'
import type { PreparedPatch } from '../src/types/edit'

function patch(
  patchId: string,
  path: string,
  oldContent: string | undefined,
  newContent: string | undefined,
  operation = 'replace_text',
): PreparedPatch {
  return {
    patchId,
    strategyId: 'test',
    path,
    oldContent,
    newContent,
    diff: '',
    changedLines: 1,
    risk: 'low',
    metadata: { op: operation },
  }
}

function createOverlay(options: {
  rebase?: (patchValue: PreparedPatch, stagedContent: string) => Promise<PreparedPatch | null>
  read?: (path: string) => Promise<string | undefined>
} = {}): TransactionOverlay {
  return new TransactionOverlay({
    rebasePatchAgainstContent: options.rebase ?? (async () => null),
    readWorkspaceFile: options.read ?? (async () => undefined),
  })
}

describe('TransactionOverlay', () => {
  test('classifies create, delete, and rename effects without collapsing empty content', () => {
    const create = patch('create', 'file.txt', undefined, '', 'create_file')
    const remove = patch('remove', 'file.txt', 'before', undefined, 'delete_file')
    const renameCreate = patch('rename-create', 'to.txt', undefined, 'moved', 'rename_file_create')
    const renameDelete = patch('rename-delete', 'from.txt', 'moved', undefined, 'rename_file_delete')

    expect(isCreatePatch(create)).toBe(true)
    expect(isDeletePatch(create)).toBe(false)
    expect(stagedContentAfter(create)).toBe('')
    expect(isDeletePatch(remove)).toBe(true)
    expect(stagedContentAfter(remove)).toBeNull()
    expect(isCreatePatch(renameCreate)).toBe(true)
    expect(stagedContentAfter(renameCreate)).toBe('moved')
    expect(isDeletePatch(renameDelete)).toBe(true)
    expect(stagedContentAfter(renameDelete)).toBeNull()
  })

  test('replays chained patches in order and preserves independent paths', async () => {
    const rebasedCalls: Array<[string, string]> = []
    const overlay = createOverlay({
      rebase: async (patchValue, stagedContent) => {
        rebasedCalls.push([patchValue.patchId, stagedContent])
        return {
          ...patchValue,
          oldContent: stagedContent,
          newContent: `${stagedContent}third\n`,
          metadata: { ...patchValue.metadata, startOffset: 10, endOffset: 20 },
        }
      },
    })

    const result = await overlay.build([
      patch('first', 'a.txt', 'disk\n', 'first\n'),
      patch('second', 'b.txt', 'other\n', 'changed\n'),
      patch('third', 'a.txt', 'stale\n', 'unused\n'),
    ])

    expect(rebasedCalls).toEqual([['third', 'first\n']])
    expect(result.contentByPath).toEqual(new Map([
      ['a.txt', 'first\nthird\n'],
      ['b.txt', 'changed\n'],
    ]))
    expect(result.diagnostics).toEqual([])
  })

  test('keeps an already chained patch on the fast path without rebasing it', async () => {
    let rebaseCalls = 0
    const overlay = createOverlay({
      rebase: async () => {
        rebaseCalls += 1
        return null
      },
    })
    const result = await overlay.build([
      patch('first', 'a.txt', 'disk', 'first'),
      patch('second', 'a.txt', 'first', 'second'),
    ])

    expect(result.contentByPath.get('a.txt')).toBe('second')
    expect(result.diagnostics).toEqual([])
    expect(rebaseCalls).toBe(0)
  })

  test('accepts a create after deletion but rejects another edit after deletion', async () => {
    const overlay = createOverlay()
    const recreated = await overlay.build([
      patch('delete', 'a.txt', 'before', undefined, 'delete_file'),
      patch('create', 'a.txt', undefined, 'fresh', 'create_file'),
    ])
    expect(recreated.contentByPath.get('a.txt')).toBe('fresh')
    expect(recreated.diagnostics).toEqual([])

    const invalid = await overlay.build([
      patch('delete', 'a.txt', 'before', undefined, 'delete_file'),
      patch('edit', 'a.txt', 'before', 'after'),
    ])
    expect(invalid.contentByPath.get('a.txt')).toBeNull()
    expect(invalid.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        path: 'a.txt',
        source: 'core.transaction-replay',
        data: { patchId: 'edit', operation: 'replace_text' },
      }),
    ])
  })

  test('turns rebase exceptions into diagnostics without changing the last valid content', async () => {
    const overlay = createOverlay({
      rebase: async () => {
        throw new Error('adapter exploded')
      },
    })
    const result = await overlay.build([
      patch('first', 'a.txt', 'disk', 'first'),
      patch('second', 'a.txt', 'stale', 'second'),
    ])

    expect(result.contentByPath.get('a.txt')).toBe('first')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        path: 'a.txt',
        source: 'core.transaction-replay',
        message: '重放同一文件的后续补丁失败：adapter exploded',
      }),
    ])
  })

  test('reads overlay content first and only falls back for untouched paths', async () => {
    const workspaceReads: string[] = []
    const overlay = createOverlay({
      read: async (path) => {
        workspaceReads.push(path)
        return `workspace:${path}`
      },
    })
    const reader = overlay.createReader(new Map([
      ['present.txt', ''],
      ['deleted.txt', null],
    ]))

    expect(await reader('present.txt')).toBe('')
    expect(await reader('deleted.txt')).toBeUndefined()
    expect(await reader('untouched.txt')).toBe('workspace:untouched.txt')
    expect(workspaceReads).toEqual(['untouched.txt'])
  })

  test('removes staged offsets while retaining the remaining metadata', () => {
    const input = patch('patch', 'a.txt', 'before', 'after')
    input.metadata = { op: 'replace_text', startOffset: 1, endOffset: 2, marker: true }

    expect(withoutStagedOffsets(input)).toMatchObject({
      metadata: { op: 'replace_text', marker: true },
    })
    expect(withoutStagedOffsets(input).metadata).not.toHaveProperty('startOffset')
    expect(withoutStagedOffsets(input).metadata).not.toHaveProperty('endOffset')
  })
})
