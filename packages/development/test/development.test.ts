import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { isProjectCodeLanguageQuery } from '@velaros-ai/project/contracts'
import { createProjectKernel } from '@velaros-ai/project/runtime'

import {
  createProjectCodeQuery,
  executeProjectCodeLanguageQuery,
  type LanguageToolContext,
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

  test('executes language actions with only workspace and source-read ports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-code-query-'))
    try {
      await writeFile(join(root, 'user.ts'), 'export class UserService {}\n')
      const kernel = await createProjectKernel({ root })
      let directory: string | null = null
      const context: LanguageToolContext = {
        abortSignal: new AbortController().signal,
        project: {
          getRootPath: () => root,
          runInDirectory: async (path, action) => {
            directory = path
            return action()
          },
          kernel: async () => ({
            listFiles: kernel.listFiles.bind(kernel),
            read: kernel.read.bind(kernel),
            listSymbols: kernel.listSymbols.bind(kernel),
          }),
        },
      }

      const result = await executeProjectCodeLanguageQuery(
        { action: 'find_symbols', query: 'UserService', exact: true, cwd: '.' },
        context
      )
      expect(result).toMatchObject({
        source: 'language-service',
        symbolCount: 1,
      })
      expect(directory).toBe('.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('cancellation during source discovery stops before file reads', async () => {
    const abort = new AbortController()
    let reads = 0
    const context: LanguageToolContext = {
      abortSignal: abort.signal,
      project: {
        getRootPath: () => '/project',
        runInDirectory: async (_path, action) => action(),
        kernel: async () => ({
          listFiles: async () => {
            abort.abort(new Error('language query cancelled'))
            return [{ path: 'source.ts', type: 'file' }]
          },
          read: async () => {
            reads += 1
            throw new Error('cancelled query must not read source')
          },
          listSymbols: async () => [],
        }),
      },
    }
    await expect(
      executeProjectCodeLanguageQuery({ action: 'find_symbols' }, context)
    ).rejects.toThrow('language query cancelled')
    expect(reads).toBe(0)
  })
})
