import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const RepoRoot = resolve(import.meta.dir, '../../..')
const HostSources = [
  'packages/serve-host/package.json',
  'packages/serve-host/src/host.ts',
  'packages/serve-host/src/tool-gateway.ts',
  'packages/serve-host/src/capability-contexts.ts',
  'packages/serve-host/src/permission-policy.ts',
  'products/host/src/bin.ts',
  'scripts/host/build-host-product.mjs',
]

describe('Velar Host renderer boundary', () => {
  test('does not embed Office, PDF, or native canvas rendering', async () => {
    for (const relativePath of HostSources) {
      const source = (await readFile(join(RepoRoot, relativePath), 'utf8')).toLowerCase()
      expect(source).not.toContain('@velaros-ai/office')
      expect(source).not.toContain('pdfjs')
      expect(source).not.toContain('@napi-rs/canvas')
      expect(source).not.toContain('velaros.office')
    }
  })
})
