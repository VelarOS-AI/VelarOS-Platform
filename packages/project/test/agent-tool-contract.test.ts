import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { isCanonicalToolId, schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import { defineProjectTool, projectTools } from '../src/agent/Project.tool'
import {
  type AgentProjectKernelPort,
  executeAgentProjectRead,
  executeAgentProjectSearch,
} from '../src/agent/ProjectKernelPort'
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

  test('requires every discovery example to satisfy the executable schema', () => {
    expect(() =>
      defineProjectTool({
        name: 'project:invalid-example',
        category: 'project-files',
        role: 'inspect',
        summary: 'invalid example guard',
        examples: [{}],
        schema: z.object({ path: z.string().min(1) }),
        permissions: ['fs:read'],
        execute: async () => null,
      })
    ).toThrow('example does not satisfy schema')

    expect(projectTools[ProjectToolNames.read].description).toContain(
      "path: ['src/contentHash.ts', 'src/cacheKey.ts']"
    )
    expect(projectTools[ProjectToolNames.run].description).toContain("command: 'bun test'")
  })

  test('keeps long-form file writes on a shallow dedicated contract', () => {
    const writeTool = projectTools[ProjectToolNames.write]
    const writeSchema = schemaToInputSchema(writeTool.schema)
    const serialized = JSON.stringify(writeSchema)

    expect(serialized.length).toBeLessThanOrEqual(800)
    expect(writeTool.schema.safeParse({
      path: 'reports/review.md',
      content: '# Review\n\nPassed.',
      mode: 'create',
    }).success).toBe(true)
    expect(writeTool.description).toContain('project:edit')
    expect(projectTools[ProjectToolNames.edit].description).toContain('project:write')
  })

  test('projects rich kernel reads onto the narrow Agent contract', async () => {
    const richSnapshot = {
      path: 'src/example.ts',
      absPath: '/private/workspace/src/example.ts',
      exists: true,
      isDirectory: false,
      isBinary: false,
      content: 'export const example = true\n',
      size: 28,
      encoding: 'utf8',
      sha256: 'private-content-hash',
      revision: 'revision-1',
      mtimeMs: 1,
      adapterIds: ['typescript'],
    }
    const project = {
      read: async () => ({
        snapshot: richSnapshot,
        content: richSnapshot.content,
        totalLines: 2,
        truncated: false,
        hasMore: false,
      }),
      status: async () => ({ root: '/private/workspace', validators: [] }),
    } as unknown as AgentProjectKernelPort

    const result = await executeAgentProjectRead(project, {
      path: 'src/example.ts',
    })

    expect(result.files).toEqual([{
      snapshot: {
        path: 'src/example.ts',
        exists: true,
        isDirectory: false,
        isBinary: false,
        revision: 'revision-1',
      },
      content: 'export const example = true\n',
      totalLines: 2,
      truncated: false,
      hasMore: false,
    }])
    expect(JSON.stringify(result.files)).not.toContain('/private/workspace/src/example.ts')
    expect(JSON.stringify(result.files)).not.toContain('private-content-hash')
    expect(JSON.stringify(result.files).match(/export const example = true/g)).toHaveLength(1)
  })

  test('turns unreadable read targets into explicit path-discovery guidance', async () => {
    const project = {
      read: async ({ path }: { path: string }) => ({
        snapshot: {
          path,
          exists: path !== 'missing.ts',
          isDirectory: path === 'src',
          isBinary: false,
          revision: `revision-${path}`,
        },
      }),
      status: async () => ({ root: '/private/workspace', validators: [] }),
    } as unknown as AgentProjectKernelPort

    const result = await executeAgentProjectRead(project, {
      path: ['src', 'missing.ts'],
    })

    expect(result.issues).toEqual([
      {
        path: 'src',
        reason: 'directory',
        message: '该路径是目录；project:read 不会枚举目录内容。',
      },
      {
        path: 'missing.ts',
        reason: 'not_found',
        message: '路径不存在，未读取任何内容。',
      },
    ])
    expect(result.nextAction).toBe(
      '先用 project:list 枚举精确路径，再调用 project:read；不要继续猜测文件名。'
    )
  })

  test('projects and bounds rich kernel search results at the Agent boundary', async () => {
    const richHits = Array.from({ length: 100 }, (_, index) => ({
      path: `src/example-${index}.ts`,
      revision: `revision-${index}`,
      score: 100 - index,
      kind: 'text' as const,
      range: { startLine: index + 1, startColumn: 1, endLine: index + 1, endColumn: 20 },
      snippet: `export const example${index} = true`,
      adapterId: 'private-adapter',
      trust: { source: 'project' as const, trust: 'untrusted' as const },
    }))
    const project = {
      search: async () => ({
        query: 'example',
        hits: richHits,
        truncated: true,
        backend: 'ripgrep',
        scannedFiles: 10_000,
      }),
    } as unknown as AgentProjectKernelPort

    const result = await executeAgentProjectSearch(project, { query: 'example', limit: 100 })
    const serialized = JSON.stringify(result)

    expect(result.truncated).toBe(true)
    expect(result.nextAction).toContain('收窄')
    expect(serialized.length).toBeLessThanOrEqual(25_000)
    expect(result.hits[0]).toEqual({
      path: 'src/example-0.ts',
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 },
      snippet: 'export const example0 = true',
    })
    expect(serialized).not.toContain('revision-0')
    expect(serialized).not.toContain('private-adapter')
    expect(serialized).not.toContain('ripgrep')
    expect(serialized).not.toContain('untrusted')
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
