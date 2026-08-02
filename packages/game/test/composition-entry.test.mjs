import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

void describe('game package entries', () => {
  void test('keeps contracts independent from host runtime and mod bindings', async () => {
    const source = await readFile(new URL('../dist/contracts.js', import.meta.url), 'utf8')

    expect(source).not.toContain('./composition')
    expect(source).not.toContain('./runtime')
    expect(source).not.toContain('node:')
  })

  void test('keeps host composition concerns on explicit subpaths', async () => {
    const source = await readFile(new URL('../dist/composition/index.js', import.meta.url), 'utf8')

    expect(source).not.toContain('./mod')
    expect(source).not.toContain('./turn-context')
  })
})
