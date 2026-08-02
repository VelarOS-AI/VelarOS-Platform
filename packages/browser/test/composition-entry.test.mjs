import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

void describe('browser composition entry', () => {
  void test('keeps the renderer entry isolated from host-side mod bindings', async () => {
    const source = await readFile(new URL('../dist/composition/index.js', import.meta.url), 'utf8')

    expect(source).not.toContain('./mod')
    expect(source).not.toContain('node:')
  })
})
