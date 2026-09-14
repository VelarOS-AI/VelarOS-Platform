import { expect, test } from 'bun:test'

import { ExecutionProgress } from '../src/tools/recovery/ExecutionProgress'

test('changing unrelated parameters or reading another file does not clear an unresolved obstacle', () => {
  const progress = new ExecutionProgress()
  const fail = (text: string) =>
    progress.record({
      toolName: 'edit',
      args: { edits: [{ path: 'a.ts', oldText: text }] },
      error: 'not found',
      result: { code: 'TARGET_NOT_FOUND' },
    })
  expect(fail('one')).toBeUndefined()
  progress.record({ toolName: 'read', args: { path: 'other.ts' }, result: { revision: 'O' } })
  expect(fail('two')).toBeUndefined()
  expect(fail('three')).toContain('3 attempts')
  progress.record({ toolName: 'read', args: { path: 'a.ts' }, result: { revision: 'A' } })
  expect(fail('four')).toBeUndefined()
  progress.record({ toolName: 'read', args: { path: 'a.ts' }, result: { revision: 'A' } })
  expect(fail('five')).toBeUndefined()
  expect(fail('six')).toContain('3 attempts')
})

test('different resources and changed revision are independent exploration', () => {
  const progress = new ExecutionProgress()
  for (let i = 0; i < 20; i++)
    expect(
      progress.record({
        toolName: 'edit',
        args: { path: `${i}.ts` },
        error: 'missing',
        result: { code: 'NOT_FOUND' },
      })
    ).toBeUndefined()
  for (let i = 0; i < 20; i++)
    expect(
      progress.record({
        toolName: 'edit',
        args: { path: 'a.ts', baseRevision: `${i}` },
        error: 'changed',
        result: { code: 'REVISION' },
      })
    ).toBeUndefined()
})
