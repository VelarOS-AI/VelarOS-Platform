import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel } from '@velaros-ai/velaros/project'
import { ProjectCodeLanguageActions } from '@velaros-ai/velaros/project/contracts'

import { createProjectCodeQuery, languageQueries, type LanguageToolContext } from '../index'

describe('@velaros-ai/velaros/project', () => {
  test('routes CodeGraph actions through the optional Project index overlay', async () => {
    const calls: string[] = []
    const queryCode = createProjectCodeQuery({
      isAvailable: () => true,
      query: async (input) => {
        calls.push(input.action)
        return { action: input.action }
      },
    })

    await expect(queryCode({ action: 'explore', nodeIds: ['n1'] }, {} as never)).resolves.toEqual({
      source: 'codegraph',
      action: 'explore',
    })
    expect(calls).toEqual(['explore'])
    expect(ProjectCodeLanguageActions).toContain('find_symbols')
    expect(ProjectCodeLanguageActions).not.toContain('build_index' as never)
  })

  test('keeps the built-in tool alive when CodeGraph is unavailable', async () => {
    const queryCode = createProjectCodeQuery({
      isAvailable: () => false,
      query: async () => null,
    })

    await expect(queryCode({ action: 'explore', nodeIds: ['n1'] }, {} as never)).rejects.toThrow(
      '需要安装并启用 CodeGraph'
    )
  })

  test('executes language actions with only workspace and source-read ports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-code-query-'))
    try {
      await writeFile(join(root, 'user.ts'), 'export class UserService {}\n')
      const kernel = await createProjectKernel({ root })
      const context: LanguageToolContext = {
        abortSignal: new AbortController().signal,
        project: {
          getRootPath: () => root,
          kernel: async () => ({
            listFiles: kernel.listFiles.bind(kernel),
            read: kernel.read.bind(kernel),
            listSymbols: kernel.listSymbols.bind(kernel),
          }),
        },
      }

      // 端口上只剩项目根与内核读端口：路径一律相对项目根，没有「按目录执行」。
      const result = await languageQueries.run(
        { action: 'find_symbols', query: 'UserService', exact: true },
        context
      )
      expect(result).toMatchObject({
        source: 'language-service',
        symbolCount: 1,
      })
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
    await expect(languageQueries.run({ action: 'find_symbols' }, context)).rejects.toThrow(
      'language query cancelled'
    )
    expect(reads).toBe(0)
  })
})
