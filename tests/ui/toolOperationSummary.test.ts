import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { getToolOperations } from '../../packages/ui/src/conversation/tool-render/toolOperationSummary'

function call(toolName: string, args: Record<string, unknown>): { toolName: string; args: Record<string, unknown> } {
  return { toolName, args }
}

void describe('getToolOperations', () => {
  void test('lists every project:edit operation with its target in call order', () => {
    assert.deepEqual(
      getToolOperations(
        call('project:edit', {
          operations: [
            {
              operation: { type: 'replace_text', path: 'src/a.ts', oldText: 'x', newText: 'y' },
              reason: 'fix',
            },
            { operation: { type: 'rename_file', from: 'src/old.ts', to: 'src/new.ts' } },
            {
              operation: {
                type: 'replace_symbol',
                path: 'src/user.ts',
                symbol: { name: 'UserService' },
                replacement: '',
                mode: 'body',
              },
            },
            {
              operation: {
                type: 'json_patch',
                path: 'package.json',
                patches: [{ op: 'replace', path: '/version', value: '1.0.0' }],
              },
            },
            { operation: { type: 'add_import', path: 'src/a.ts', module: 'react', named: ['useState'] } },
            // 模型偶尔把 operation 平铺在数组项上。
            { type: 'delete_file', path: 'src/unused.ts' },
          ],
        })
      ),
      [
        { id: 'replace_text', target: 'src/a.ts' },
        { id: 'rename_file', target: 'src/old.ts → src/new.ts' },
        { id: 'replace_symbol', target: 'src/user.ts · UserService · body' },
        { id: 'json_patch', target: 'package.json · replace /version' },
        { id: 'add_import', target: 'src/a.ts · react' },
        { id: 'delete_file', target: 'src/unused.ts' },
      ]
    )
  })

  void test('formats operation paths with the host formatter', () => {
    const formatPath = (path: string): string => path.replace('/root/', '')

    assert.deepEqual(
      getToolOperations(
        call('project:edit', {
          operations: [
            { operation: { type: 'delete_file', path: '/root/src/a.ts' } },
            { operation: { type: 'rename_file', from: '/root/a.md', to: '/root/b.md' } },
          ],
        }),
        formatPath
      ),
      [
        { id: 'delete_file', target: 'src/a.ts' },
        { id: 'rename_file', target: 'a.md → b.md' },
      ]
    )
  })

  void test('reads the project:write mode and the project:query-code action with its subject', () => {
    assert.deepEqual(
      getToolOperations(call('project:write', { path: 'notes.md', content: '# Notes', mode: 'append' })),
      [{ id: 'append', target: 'notes.md' }]
    )
    assert.deepEqual(
      getToolOperations(
        call('project:query-code', { action: 'find_references', symbol: 'UserService', path: 'src/user.ts' })
      ),
      [{ id: 'find_references', target: 'UserService · src/user.ts' }]
    )
    assert.deepEqual(
      getToolOperations(call('project:query-code', { action: 'language_diagnostics', path: 'src' })),
      [{ id: 'language_diagnostics', target: 'src' }]
    )
    assert.deepEqual(
      getToolOperations(call('project:query-code', { action: 'trace', fromSymbol: 'login', toSymbol: 'save' })),
      [{ id: 'trace', target: 'login → save' }]
    )
    assert.deepEqual(getToolOperations(call('project:query-code', { action: 'index_status' })), [
      { id: 'index_status' },
    ])
  })

  void test('names browser:act sub-actions and their element or input', () => {
    assert.deepEqual(
      getToolOperations(
        call('browser:act', { action: 'target', targetAction: 'click', target: { role: 'button', name: '提交' } })
      ),
      [{ id: 'target.click', target: 'button 提交' }]
    )
    assert.deepEqual(
      getToolOperations(
        call('browser:act', { action: 'navigate', navigationAction: 'goto', url: 'https://example.com' })
      ),
      [{ id: 'navigate.goto', target: 'https://example.com' }]
    )
    assert.deepEqual(
      getToolOperations(call('browser:act', { action: 'press_key', key: 'Enter', modifiers: ['meta'] })),
      [{ id: 'press_key', target: 'meta+Enter' }]
    )
    assert.deepEqual(getToolOperations(call('browser:act', { action: 'set_page_zoom', zoomAction: 'in' })), [
      { id: 'set_page_zoom.in' },
    ])
  })

  void test('expands the defaults of tools whose selector is optional', () => {
    assert.deepEqual(getToolOperations(call('memory:search', { query: '回复语言偏好' })), [
      { id: 'search', target: '回复语言偏好' },
    ])
    assert.deepEqual(getToolOperations(call('memory:search', { mode: 'profile' })), [{ id: 'profile' }])
    assert.deepEqual(getToolOperations(call('tooling:map', {})), [{ id: 'map' }])
    assert.deepEqual(getToolOperations(call('tooling:map', { op: 'find', query: 'read document' })), [
      { id: 'find', target: 'read document' },
    ])
    assert.deepEqual(
      getToolOperations(
        call('agent:dispatch', { agent_name: 'Scout', description: 'Scan auth module', prompt: 'Read src/auth.' })
      ),
      [{ id: 'sync', target: 'Scout · Scan auth module' }]
    )
    assert.deepEqual(
      getToolOperations(call('agent:dispatch', { thread_id: 'subagent:1', interrupt: true })),
      [{ id: 'interrupt', target: 'subagent:1' }]
    )
    assert.deepEqual(getToolOperations(call('system:processes', {})), [
      { id: 'processes' },
      { id: 'ports' },
      { id: 'tasks' },
    ])
    assert.deepEqual(
      getToolOperations(call('system:processes', { include: ['ports'], filter: 'velaros' })),
      [{ id: 'ports', target: 'velaros' }]
    )
  })

  void test('reads workflow steps, goal updates, search mode and command flags', () => {
    assert.deepEqual(
      getToolOperations(
        call('agent:run_workflow', {
          steps: [
            { id: 'scan', operation: 'parallel' },
            { id: 'vote', operation: 'majority_vote' },
          ],
        })
      ),
      [
        { id: 'parallel', target: 'scan' },
        { id: 'majority_vote', target: 'vote' },
      ]
    )
    assert.deepEqual(getToolOperations(call('goal:update', { status: 'complete' })), [{ id: 'complete' }])
    assert.deepEqual(getToolOperations(call('goal:update', { complete_step: 2 })), [
      { id: 'complete_step', target: '2' },
    ])
    assert.deepEqual(getToolOperations(call('project:search', { query: 'a|b', regex: true, path: 'src' })), [
      { id: 'regex', target: 'a|b · src' },
    ])
    assert.deepEqual(getToolOperations(call('project:search', { query: 'contentHash' })), [])
    assert.deepEqual(getToolOperations(call('project:run', { command: 'bun run dev', background: true })), [
      { id: 'background' },
    ])
    assert.deepEqual(getToolOperations(call('project:run', { command: 'bun test' })), [])
  })

  void test('falls back to generic selectors and operation arrays for unregistered tools', () => {
    assert.deepEqual(getToolOperations(call('browser:files', { action: 'list', path: '/downloads' })), [
      { id: 'list', target: '/downloads' },
    ])
    assert.deepEqual(
      getToolOperations(
        call('office:docx', {
          path: 'report.docx',
          edits: [
            { type: 'replace', find: 'draft' },
            { op: 'insert', path: 'body' },
          ],
        })
      ),
      [{ id: 'replace' }, { id: 'insert', target: 'body' }]
    )
    // 主选择字段（operation / action / op / mode）优先于类型字段（kind / type）。
    assert.deepEqual(getToolOperations(call('custom:report', { type: 'weekly', mode: 'draft' })), [
      { id: 'draft' },
    ])
    assert.deepEqual(getToolOperations(call('custom:sync', { operation: { type: 'push', path: 'a.txt' } })), [
      { id: 'push', target: 'a.txt' },
    ])
  })

  void test('ignores prose, blanks and malformed arguments', () => {
    assert.deepEqual(getToolOperations(call('custom:tool', { type: 'a sentence with spaces' })), [])
    assert.deepEqual(getToolOperations(call('custom:tool', { action: '   ' })), [])
    assert.deepEqual(getToolOperations(call('project:edit', { operations: 'not-an-array' })), [])
    assert.deepEqual(
      getToolOperations(call('project:edit', { operations: [null, { operation: { path: 'a.ts' } }] })),
      []
    )
    assert.deepEqual(getToolOperations({ toolName: 'project:edit', args: null as never }), [])
  })

  void test('truncates very long targets instead of carrying whole payloads into the bubble', () => {
    const [operation] = getToolOperations(call('memory:search', { query: 'x'.repeat(500) }))

    assert.equal(operation?.target?.length, 161)
    assert.ok(operation?.target?.endsWith('…'))
  })
})
