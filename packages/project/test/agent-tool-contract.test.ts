import { describe, expect, test } from 'bun:test'

import { isCanonicalToolId, schemaToInputSchema } from '@velaros-ai/core/tool-contract'

import { projectTools } from '../src/agent/Project.tool'
import { ProjectEditOperationSchema } from '../src/edit-schema'
import { ProjectToolNames } from '../src/project-tool-names'

const ModelToolSchemaCharacterBudget = 40_000

describe('Project model-facing tool contract', () => {
  test('keeps the public tool surface precise and canonical', () => {
    expect(Object.keys(projectTools)).toEqual(Object.values(ProjectToolNames))
    expect(Object.keys(projectTools).every(isCanonicalToolId)).toBe(true)
  })

  test('keeps the complete model schema below the request budget', () => {
    const schema = Object.entries(projectTools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: schemaToInputSchema(tool.schema),
    }))

    expect(JSON.stringify(schema).length).toBeLessThanOrEqual(ModelToolSchemaCharacterBudget)
  })

  test('exposes only executable edit operations', () => {
    const executableSamples = [
      { type: 'replace_text', path: 'a.ts', oldText: 'a', newText: 'b' },
      {
        type: 'insert_text_at_anchor',
        path: 'a.ts',
        anchorText: 'a',
        position: 'after',
        text: 'b',
      },
      { type: 'append_text', path: 'a.ts', text: 'b' },
      { type: 'prepend_text', path: 'a.ts', text: 'b' },
      { type: 'delete_text', path: 'a.ts', oldText: 'a' },
      { type: 'create_file', path: 'a.ts', content: '' },
      { type: 'delete_file', path: 'a.ts' },
      { type: 'rename_file', from: 'a.ts', to: 'b.ts' },
      {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { name: 'main' },
        replacement: 'return 1',
        mode: 'body',
      },
      {
        type: 'insert_around_symbol',
        path: 'a.ts',
        symbol: { name: 'main' },
        position: 'before',
        text: 'const ready = true\n',
      },
      { type: 'add_import', path: 'a.ts', module: 'node:path', named: ['join'] },
      { type: 'remove_import', path: 'a.ts', module: 'node:path', name: 'join' },
      { type: 'json_patch', path: 'a.json', patches: [{ op: 'remove', path: '/old' }] },
    ]
    const retiredTypes = [
      'insert_text',
      'insert_before_symbol',
      'insert_after_symbol',
      'custom',
    ]

    expect(executableSamples.every((operation) => ProjectEditOperationSchema.safeParse(operation).success)).toBe(true)
    expect(
      retiredTypes.every(
        (type) => !ProjectEditOperationSchema.safeParse({ type, path: 'a.ts', text: 'x' }).success
      )
    ).toBe(true)
  })
})
