import { describe, expect, test } from 'bun:test'

import {
  createDevelopmentToolApi,
  developmentTools,
  isDevelopmentLanguageQuery,
} from '../src'
import { createDevelopmentBundledModDefinition } from '../src/composition'
import { DevelopmentToolNames } from '../src/contracts'

describe('@velaros-ai/development', () => {
  test('exposes one canonical structured tool', () => {
    expect(Object.keys(developmentTools)).toEqual([DevelopmentToolNames.queryCode])
    expect(DevelopmentToolNames.queryCode).toBe('development:query-code')
  })

  test('composes into project space', () => {
    const definition = createDevelopmentBundledModDefinition()
    expect(definition.manifest.contributes.tools[0]?.residentInSpaces).toEqual(['project'])
  })

  test('routes index and language actions through the package runtime', async () => {
    const calls: string[] = []
    const api = createDevelopmentToolApi({
      isAvailable: () => true,
      query: async (input) => {
        calls.push(input.action)
        return { action: input.action }
      },
    })

    await expect(
      api.queryCode({ action: 'index_status' }, {} as never)
    ).resolves.toEqual({ action: 'index_status' })
    expect(calls).toEqual(['index_status'])
    expect(isDevelopmentLanguageQuery({ action: 'find_symbols' })).toBe(true)
    expect(isDevelopmentLanguageQuery({ action: 'build_index', force: true })).toBe(false)
  })
})
