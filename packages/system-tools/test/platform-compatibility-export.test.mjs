import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

const packageRoot = join(import.meta.dir, '..')

describe('platform compatibility package export', () => {
  test('provides a browser-safe subpath without loading the Node tool catalog', async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    )

    expect(manifest.exports['./platform-compatibility']).toEqual({
      types: './dist/SystemPlatformCompatibility.d.ts',
      import: './dist/SystemPlatformCompatibility.js',
    })

    const source = await readFile(
      join(packageRoot, 'dist', 'SystemPlatformCompatibility.js'),
      'utf8',
    )
    expect(source).not.toMatch(/(?:from|import)\s*\(?['"]node:/)

    const exported = await import('../dist/SystemPlatformCompatibility.js')
    expect(exported.systemPlatformCompatibility.isMacOS()).toBe(
      process.platform === 'darwin',
    )
  })
})
