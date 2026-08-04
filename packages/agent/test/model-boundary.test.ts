import {
  readdirSync,
  readFileSync,
} from 'node:fs'
import {
  join,
  resolve,
} from 'node:path'

import {
  describe,
  expect,
  test,
} from 'bun:test'

import {
  applyModelRequestPolicy,
  markLatestUserMessagePromptCacheBreakpoint,
  mergeSessionPromptCacheProviderOptions,
  resolveSessionPromptCacheKey,
} from '../src/agent/model'
import { ModelRuntime } from '../src/agent/runner/ModelRuntime'

const PackageRoot = resolve(import.meta.dir, '..')

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('Agent Model boundary', () => {
  test('Agent has no concrete Model package dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PackageRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(packageJson.dependencies?.['@velaros-ai/model']).toBeUndefined()

    const offenders = listTypeScriptFiles(join(PackageRoot, 'src')).filter((path) =>
      readFileSync(path, 'utf8').includes('@velaros-ai/model')
    )
    expect(offenders).toEqual([])
  })

  test('request policy keeps explicit values and fills missing policy values', () => {
    expect(
      applyModelRequestPolicy(
        {
          temperature: 0.2,
        },
        {
          requestPolicy: {
            temperature: 0.8,
            topP: 0.7,
            maxOutputTokens: 512,
          },
        }
      )
    ).toEqual({
      temperature: 0.2,
      topP: 0.7,
      maxOutputTokens: 512,
    })
  })

  test('prompt cache identity is stable and only the latest user keeps a breakpoint', () => {
    const sessionId = 'project/session 42'
    expect(resolveSessionPromptCacheKey(sessionId)).toBe(
      resolveSessionPromptCacheKey(sessionId)
    )
    expect(
      mergeSessionPromptCacheProviderOptions({}, sessionId)?.velaros
    ).toMatchObject({
      promptCacheKey: resolveSessionPromptCacheKey(sessionId),
    })

    const messages = markLatestUserMessagePromptCacheBreakpoint([
      {
        role: 'user',
        content: 'first',
        providerOptions: {
          velaros: {
            promptCacheBreakpoint: { type: 'ephemeral' },
          },
        },
      },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'latest' },
    ])
    expect(messages[0]?.providerOptions).toBeUndefined()
    expect(messages[2]?.providerOptions?.velaros).toEqual({
      promptCacheBreakpoint: { type: 'ephemeral' },
    })
  })

  test('unwraps Agent-owned config exactly once at the injected Model capability boundary', async () => {
    const observed: unknown[] = []
    const runtime = new ModelRuntime({
      createAgentProvider: (selection) => {
        observed.push(['provider', selection])
        return (() => undefined) as never
      },
      resolveRoleRuntime: (selection, runtimeContext) => {
        observed.push(['role', selection, runtimeContext])
        return Promise.resolve({}) as never
      },
    })

    runtime.createAgentProvider({
      modelSelection: { provider: 'test', model: 'primary' },
      hostOnlyField: 'must-not-leak',
    })
    await runtime.resolveRoleRuntime(
      { modelSelection: { provider: 'test', model: 'role' } },
      {
        modelRuntimeContext: { providerRuntimeConfigs: [], openRouter: {} },
        hostOnlyField: 'must-not-leak',
      }
    )

    expect(observed).toEqual([
      ['provider', { provider: 'test', model: 'primary' }],
      [
        'role',
        { provider: 'test', model: 'role' },
        { providerRuntimeConfigs: [], openRouter: {} },
      ],
    ])
  })
})
