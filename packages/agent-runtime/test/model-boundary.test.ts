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
  test('agent-runtime has no concrete model-runtime dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PackageRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(packageJson.dependencies?.['@velaros-ai/model-runtime']).toBeUndefined()

    const offenders = listTypeScriptFiles(join(PackageRoot, 'src')).filter((path) =>
      readFileSync(path, 'utf8').includes('@velaros-ai/model-runtime')
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

  test('compatibility bridge fails fast when Model capability was not injected', () => {
    const runtime = new ModelRuntime()
    expect(() =>
      runtime.createAgentProvider({
        apiKey: '',
        baseURL: '',
      })
    ).toThrow('Agent Model capability 未注入')
  })
})
