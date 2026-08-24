import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ExternalLanguageService } from '../src/runtime/ExternalLanguageService'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ExternalLanguageService', () => {
  test('keeps stdio LSP discovery bounded to the injected project and specs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-development-lsp-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'velaros-development-lsp-outside-'))
    roots.push(root, outsideRoot)
    await writeFile(join(root, 'sample.foo'), 'example')
    const outsideFile = join(outsideRoot, 'outside.foo')
    await writeFile(outsideFile, 'outside')
    const service = new ExternalLanguageService(root, [{
      id: 'missing-test-server',
      command: 'velaros-definitely-missing-language-server',
      args: [],
      extensions: ['.foo'],
      languageId: 'foo',
    }])
    expect(service.supports('sample.foo')).toBe(true)
    expect(await service.diagnostics(['sample.foo'])).toEqual([])
    expect(service.status()).toMatchObject({ state: 'unavailable', server: 'external' })
    await expect(service.hover(outsideFile, 1, 1)).rejects.toThrow('project boundary')
    await service.stop()
  })
})
