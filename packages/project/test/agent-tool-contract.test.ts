import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { isCanonicalToolId, schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import {
  defineProjectTool,
  projectTools,
  scopeProjectListPatterns,
} from '../src/agent/Project.tool'
import {
  type AgentProjectKernelPort,
  executeAgentProjectRead,
  executeAgentProjectSearch,
} from '../src/agent/ProjectKernelPort'
import { ProjectEditOperationSchema } from '../src/edit-schema'
import { ProjectToolNames } from '../src/project-tool-names'

const ModelToolSchemaCharacterBudget = 40_000

describe('Project model-facing tool contract', () => {
  test('declares authoritative read, write, and execution capability classes', () => {
    const expectedEffects = {
      'project:read': 'read',
      'project:list': 'read',
      'project:search': 'read',
      'project:query-code': 'read',
      'project:write': 'write',
      'project:edit': 'write',
      'project:rollback': 'write',
      'project:run': 'execute',
    } as const

    for (const [name, effectKind] of Object.entries(expectedEffects)) {
      const tool = projectTools[name]
      expect(tool?.capabilities?.effectKind).toBe(effectKind)
      expect(tool?.readOnly).toBe(effectKind === 'read')
      expect(tool?.capabilities?.readScopes).toContain('project')
      expect(tool?.capabilities?.canReadArbitrarySource).toBe(false)
    }
    expect(projectTools['project:run']?.capabilities?.process?.execution).toBe('input-dependent')
  })

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

  test('accepts list globs relative to the requested directory without breaking root-relative globs', () => {
    expect(scopeProjectListPatterns('scripts/build', ['*.mjs'])).toEqual([
      'scripts/build/*.mjs',
    ])
    expect(
      scopeProjectListPatterns('scripts/build', ['scripts/build/linkedWorkspacePackages.mjs'])
    ).toEqual(['scripts/build/linkedWorkspacePackages.mjs'])
    expect(scopeProjectListPatterns('.', ['scripts/**/*.mjs'])).toEqual(['scripts/**/*.mjs'])
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

  test('shares the read character budget across files and exposes per-file continuations', async () => {
    const receivedMaxChars: number[] = []
    const project = {
      read: async ({ path, maxChars }: { path: string; maxChars: number }) => {
        receivedMaxChars.push(maxChars)
        const content = 'abcdefghij'.slice(0, maxChars)
        return {
          snapshot: {
            path,
            exists: true,
            isDirectory: false,
            isBinary: false,
            revision: `revision-${path}`,
          },
          content,
          truncated: true,
          hasMore: true,
          continuation: {
            path,
            range: { startLine: 1, startColumn: content.length + 1 },
            maxChars,
            baseRevision: `revision-${path}`,
          },
        }
      },
      status: async () => ({ root: '/private/workspace', validators: [] }),
    } as unknown as AgentProjectKernelPort

    const result = await executeAgentProjectRead(project, {
      path: ['first.txt', 'second.txt'],
      maxChars: 6,
    })

    expect(receivedMaxChars).toEqual([3, 3])
    expect(result.files.map((file) => file.content).join('').length).toBe(6)
    expect(result.files[0]?.continuation).toEqual({
      path: 'first.txt',
      range: { startLine: 1, startColumn: 4 },
      maxChars: 3,
      baseRevisions: { 'first.txt': 'revision-first.txt' },
    })
    expect(
      projectTools[ProjectToolNames.read].schema.safeParse(result.files[0]?.continuation).success
    ).toBe(true)
    expect(result.files[1]?.continuation?.path).toBe('second.txt')
  })

  test('rejects a shared read budget that cannot advance every requested file', async () => {
    let reads = 0
    const project = {
      read: async () => {
        reads += 1
        throw new Error('read should not run')
      },
      status: async () => ({ root: '/private/workspace', validators: [] }),
    } as unknown as AgentProjectKernelPort

    expect(
      projectTools[ProjectToolNames.read].schema.safeParse({
        path: ['first.txt', 'second.txt'],
        maxChars: 1,
      }).success
    ).toBe(false)
    await expect(
      executeAgentProjectRead(project, {
        path: ['first.txt', 'second.txt'],
        maxChars: 1,
      })
    ).rejects.toMatchObject({
      reason: 'INVALID_INPUT',
      details: { maxChars: 1, pathCount: 2 },
    })
    expect(reads).toBe(0)
  })

  test('keeps the default character bound when an endLine is supplied', async () => {
    let receivedInput: Record<string, unknown> | undefined
    const project = {
      read: async (input: Record<string, unknown>) => {
        receivedInput = input
        return {
          snapshot: {
            path: input.path as string,
            exists: true,
            isDirectory: false,
            isBinary: false,
          },
          content: '',
          truncated: false,
          hasMore: false,
        }
      },
      status: async () => ({ root: '/private/workspace', validators: [] }),
    } as unknown as AgentProjectKernelPort

    const result = await executeAgentProjectRead(project, {
      path: 'large.txt',
      range: { startLine: 1, endLine: 1_000_000 },
    })

    expect(receivedInput?.maxChars).toBe(500_000)
    expect(result.appliedDefaultBound).toEqual({ maxChars: 500_000 })
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
    expect(ProjectEditOperationSchema.safeParse({
      type: 'json_patch',
      path: 'a.json',
      patches: [{ op: 'replace', path: '/value' }],
    }).success).toBe(false)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'json_patch',
      path: 'a.json',
      patches: [{ op: 'remove', path: '/value', value: 1 }],
    }).success).toBe(false)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'replace_text',
      path: 'a.ts',
      oldText: 'a',
      newText: 'b',
      occurrence: 1,
      replaceAll: true,
    }).success).toBe(false)
    expect(
      retiredTypes.every(
        (type) => !ProjectEditOperationSchema.safeParse({ type, path: 'a.ts', text: 'x' }).success
      )
    ).toBe(true)
  })
})
