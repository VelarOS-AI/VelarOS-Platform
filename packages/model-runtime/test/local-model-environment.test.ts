/**
 * @test-meta
 * title: 可移植模型环境
 * summary: 包 · catalog：验证环境值只能显式注入，且不会回退读取宿主进程。
 * area: package
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  LocalModelEnvironment,
  OllamaEnvNames,
  resolveOllamaChatModel,
  resolveOllamaContextWindow,
} from '../src/LocalModelEnvironment'

const OriginalChatModel = process.env[OllamaEnvNames.chatModel]
const OriginalContextWindow = process.env[OllamaEnvNames.contextWindow]

afterEach(() => {
  restoreEnvironmentVariable(OllamaEnvNames.chatModel, OriginalChatModel)
  restoreEnvironmentVariable(OllamaEnvNames.contextWindow, OriginalContextWindow)
})

describe('LocalModelEnvironment', () => {
  test('does not read ambient process environment', () => {
    process.env[OllamaEnvNames.chatModel] = 'ambient-model'
    process.env[OllamaEnvNames.contextWindow] = '65536'

    expect(resolveOllamaChatModel('default-model')).toBe('default-model')
    expect(resolveOllamaContextWindow()).toBeNull()
  })

  test('resolves an immutable explicit environment snapshot', () => {
    const variables = {
      [OllamaEnvNames.baseURL]: 'localhost:11434/',
      [OllamaEnvNames.chatModel]: 'qwen3:8b',
      [OllamaEnvNames.contextWindow]: '32768.9',
    }
    const environment = new LocalModelEnvironment(variables)
    variables[OllamaEnvNames.chatModel] = 'changed-after-construction'

    expect(environment.resolveOllamaBaseURL('http://fallback.invalid')).toBe(
      'http://localhost:11434/v1'
    )
    expect(environment.resolveOllamaChatModel('fallback-model')).toBe('qwen3:8b')
    expect(environment.resolveOllamaContextWindow()).toBe(32768)
    expect(
      environment.resolveOllamaVisibleChatModels('fallback-model', 'qwen3:8b')
    ).toEqual(['qwen3:8b'])
  })

  test('accepts a custom environment port without copying host state', () => {
    const environment = LocalModelEnvironment.from({
      read: (name) =>
        name === OllamaEnvNames.contextWindow ? '16384' : undefined,
    })

    expect(environment.resolveOllamaContextWindow()).toBe(16384)
  })
})

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = value
}
