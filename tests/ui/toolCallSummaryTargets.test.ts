import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolCallBlock } from '../../packages/ui/src/conversation/contracts'
import { getMergedToolDetails } from '../../packages/ui/src/conversation/tool-render/messageBubbleToolModel'
import { isFileChangeToolName } from '../../packages/ui/src/conversation/tool-render/toolActivityPredicates'
import {
  getToolDetailItems,
  getToolDetailSummary,
  getToolSearchScopeItems,
} from '../../packages/ui/src/conversation/tool-render/toolCallSummary'
import { FileChangeToolNames } from '../../packages/ui/src/conversation/tool-render/toolRenderToolNames'

function toolCall(toolName: string, args: Record<string, unknown>, id = toolName): ToolCallBlock {
  return { type: 'tool-call', toolCallId: id, toolName, args }
}

void describe('tool row targets', () => {
  void test('a batch project:read names its first file and counts the rest', () => {
    const block = toolCall('project:read', { path: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })

    assert.equal(getToolDetailSummary(block), 'src/a.ts +2')
    assert.deepEqual(getToolDetailItems(block), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
    assert.equal(getToolDetailSummary(toolCall('project:read', { path: 'src/a.ts' })), 'src/a.ts')
  })

  void test('project:search leads with what it searched for and keeps the scope for the hover details', () => {
    const block = toolCall('project:search', { query: 'contentHash', path: 'packages/project/src' })

    assert.equal(getToolDetailSummary(block), 'contentHash')
    assert.deepEqual(getToolDetailItems(block), ['contentHash'])
    assert.deepEqual(getToolSearchScopeItems(block), ['packages/project/src'])
    assert.deepEqual(
      getToolSearchScopeItems(block, (path) => path.replace('packages/', '')),
      ['project/src']
    )
  })

  void test('project:query-code leads with the symbol or query and falls back to the path', () => {
    assert.equal(
      getToolDetailSummary(
        toolCall('project:query-code', { action: 'find_references', symbol: 'UserService', path: 'src/user.ts' })
      ),
      'UserService'
    )
    assert.equal(
      getToolDetailSummary(toolCall('project:query-code', { action: 'search_symbols', query: 'Session' })),
      'Session'
    )
    const diagnostics = toolCall('project:query-code', { action: 'language_diagnostics', path: 'src/user.ts' })
    assert.equal(getToolDetailSummary(diagnostics), 'src/user.ts')
    assert.deepEqual(getToolSearchScopeItems(diagnostics), [])
  })

  void test('a merged search row previews the queries rather than the shared scope', () => {
    assert.deepEqual(
      getMergedToolDetails([
        toolCall('project:search', { query: 'foo', path: 'src' }, 'search-1'),
        toolCall('project:search', { query: 'bar', path: 'src' }, 'search-2'),
      ]),
      ['foo', 'bar']
    )
  })

  void test('project:write renders and counts as a file change like project:edit', () => {
    assert.equal(isFileChangeToolName('project:write'), true)
    assert.ok(FileChangeToolNames.includes('project:write'))
    assert.ok(FileChangeToolNames.includes('project:edit'))
  })
})
