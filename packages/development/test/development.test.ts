import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'
import { isProjectCodeLanguageQuery } from '@velaros-ai/project/contracts'
import { createProjectKernel } from '@velaros-ai/project/runtime'

import {
  createProjectCodeQuery,
} from '../src'

describe('@velaros-ai/development', () => {
  test('routes CodeGraph actions through the optional Project index overlay', async () => {
    const calls: string[] = []
    const queryCode = createProjectCodeQuery({
      isAvailable: () => true,
      query: async (input) => {
        calls.push(input.action)
        return { action: input.action }
      },
    })

    await expect(
      queryCode({ action: 'index_status' }, {} as never)
    ).resolves.toEqual({ source: 'codegraph', action: 'index_status' })
    expect(calls).toEqual(['index_status'])
    expect(isProjectCodeLanguageQuery({ action: 'find_symbols' })).toBe(true)
    expect(isProjectCodeLanguageQuery({ action: 'build_index', force: true })).toBe(false)
  })

  test('keeps the built-in tool alive when CodeGraph is unavailable', async () => {
    const queryCode = createProjectCodeQuery({
      isAvailable: () => false,
      query: async () => null,
    })

    await expect(queryCode({ action: 'index_status' }, {} as never)).rejects.toThrow(
      '需要安装并启用 CodeGraph'
    )
  })

  test('executes built-in language actions without CodeGraph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-code-query-'))
    try {
      await writeFile(join(root, 'user.ts'), 'export class UserService {}\n')
      const kernel = await createProjectKernel({ root })
      const queryCode = createProjectCodeQuery({
        isAvailable: () => false,
        query: async () => null,
      })
      const context = {
        abortSignal: new AbortController().signal,
        project: {
          getRootPath: () => root,
          runInDirectory: async (_path: string, action: () => Promise<unknown>) => action(),
          kernel: async () => kernel,
          runWithApproval: async (action: () => Promise<unknown>) => action(),
          prepareMutation: async () => ({ approved: false }),
          runCommand: async () => ({}),
          queryCode,
        },
        system: { canStartBackgroundCommands: () => false },
        approval: defaultDenyApprovalPort,
      }

      const result = await queryCode(
        { action: 'find_symbols', query: 'UserService', exact: true },
        context as never
      )
      expect(result).toMatchObject({
        source: 'language-service',
        symbolCount: 1,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
