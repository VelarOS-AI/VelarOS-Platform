import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

void describe('browser renderer entry', () => {
  void test('keeps the renderer entry isolated from host-side bindings and node builtins', async () => {
    const source = await readFile(new URL('../../dist/browser/renderer.js', import.meta.url), 'utf8')

    expect(source).not.toContain('BrowserTools')
    expect(source).not.toContain('node:')
  })
})
