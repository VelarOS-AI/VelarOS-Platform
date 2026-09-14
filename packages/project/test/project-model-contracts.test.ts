import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

import { DefaultToolContractExampleRegistry, schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import { ToolArgsSchemaValidator } from '../../agent/src/tools/ToolArgsSchemaValidator'
import { ProjectChangeSchema } from '../src/agent/contracts/change'
import { ProjectEditSchema } from '../src/agent/contracts/edit'
import { ProjectReadInputSchema } from '../src/agent/contracts/read'
import { projectTools } from '../src/agent/Project.tool'

describe('model-facing Project examples and normalization', () => {
  test('readonly search never mandates discovery tools absent from its role surface', () => {
    const description = projectTools['project:search'].description
    expect(description).toContain('当前可用的 project:code')
    expect(description).toContain('本轮已提供的工具发现入口')
    expect(description).toContain('候选证据')
    expect(description).not.toMatch(/tooling:(?:map|replace)/u)
  })

  test('all eight tool examples survive wire encoding and satisfy their actual schema', () => {
    expect(Object.keys(projectTools)).toHaveLength(8)
    for (const tool of Object.values(projectTools)) {
      const inputSchema = schemaToInputSchema(tool.schema)
      expect(inputSchema.type === 'object' || Array.isArray(inputSchema.oneOf)).toBe(true)
      expect(JSON.stringify(inputSchema)).not.toBe('{"type":"object"}')
      const examples = DefaultToolContractExampleRegistry.get(tool.name)
      expect(examples?.length).toBeGreaterThan(0)
      for (const example of examples ?? []) {
        const wire = JSON.stringify(example)
        expect(tool.schema.safeParse(JSON.parse(wire)).success).toBe(true)
        expect(tool.description).toContain(wire)
        expect(wire).not.toMatch(/(?:view|change|symbol):(?:from-|a17)/u)
        if (wire.includes('<fileRef>') || wire.includes('<changeRef>')) expect(tool.description).toContain('必须替换')
      }
    }
  })

  test('README and proposal editing templates parse after explicit receipt substitution', async () => {
    const files = [
      new URL('../README.md', import.meta.url),
      new URL('../../../docs/engineering/project-tool-surface-redesign-proposal.md', import.meta.url),
    ]
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      expect(text).toContain('参数模板')
      const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]!))
      const edits = blocks.filter((value) => Array.isArray(value.files))
      expect(edits).toHaveLength(1)
      expect(edits[0].files[0].fileRef).toBe('<fileRef>')
      edits[0].files[0].fileRef = `view:${'a'.repeat(64)}`
      // Syntax validation does not grant permission: real execution resolves a stored receipt.
      expect(ProjectEditSchema.safeParse(edits[0]).success).toBe(true)
    }
  })

  test('normalization repairs JSON containers without decoding or trimming source strings again', () => {
    const text = '  "literal" \\n \\u0041 C:\\src\\file\r\n中文🙂\n'
    const files = [{ fileRef: '<fileRef>', edits: [{ op: 'replace', range: [42, 45], match: '"old"\\n', text }] }]
    const normalized = new ToolArgsSchemaValidator().validateWithNormalization(ProjectEditSchema, { files: JSON.stringify(files) })
    expect(normalized.success).toBe(true)
    if (!normalized.success) return
    expect(normalized.args).toEqual({ files })
    expect(normalized.adjustments).toEqual([{ field: 'files', action: 'coerced', detail: expect.any(String) }])
    expect(ProjectReadInputSchema.parse({ path: 'a.ts', range: [42] }).range).toEqual([42])
  })

  test('precise selectors and operation choices reject ambiguity instead of stripping, clamping or defaulting', () => {
    const validate = new ToolArgsSchemaValidator()
    for (const range of [[45, 42], 0, 1.5, [1, 2, 3]]) {
      expect(validate.validateWithNormalization(ProjectEditSchema, {
        files: [{ fileRef: '<fileRef>', edits: [{ op: 'replace', range, text: 'new' }] }],
      }).success).toBe(false)
    }
    for (const edits of [
      [{ op: 'insert', at: 'start', side: 'before', text: 'new' }],
      [{ op: 'replace', range: 1 }],
      [{ op: 'replace_text', match: 'old', text: 'new' }],
    ]) expect(validate.validateWithNormalization(ProjectEditSchema, { files: [{ fileRef: '<fileRef>', edits }] }).success).toBe(false)
    expect(validate.validateWithNormalization(ProjectReadInputSchema, { path: 'a.ts', files: [{ path: 'b.ts' }] }).success).toBe(false)
    expect(validate.validateWithNormalization(ProjectChangeSchema, { action: 'undo', changeRef: '<changeRef>', steps: [{ tool: 'file', actions: [{ op: 'create', path: 'new.ts', text: '' }] }] }).success).toBe(false)
    expect(projectTools['project:edit'].schema.safeParse({ reuse: 'attempt:failed', changes: [{ op: 'set', path: ['files', 0, 'edits', 0, 'range'], value: 42 }] }).success).toBe(true)
    expect(projectTools['project:edit'].schema.safeParse({ reuse: 'attempt:failed', changes: [{ op: 'set', path: ['files'], value: [] }], files: [] }).success).toBe(false)
  })
})
