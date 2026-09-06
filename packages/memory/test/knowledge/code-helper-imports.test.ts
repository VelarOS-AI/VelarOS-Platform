import { describe, expect, test } from 'bun:test'

import { extractImports } from '../../src/knowledge/knowledge/domain/CodeHelper'

describe('knowledge code import extraction', () => {
  test('extracts side-effect imports, from specifiers, and direct require assignments', () => {
    const records = extractImports('/repo/source.ts', [
      "import './setup'",
      "import type { Model } from './model'",
      "import { from as alias } from './aliased'",
      "import runtimeDefault, { helper } from './mixed'",
      "import * as namespace from './namespace'",
      "export { value } from './values'",
      "export * from './all'",
      "export * as helpers from './helpers'",
      "export type { Model } from './types'",
      "const runtime = require('./runtime')",
      "const defaultRuntime = require('./default-runtime').default",
      "const commented = require('./commented'); // retained comment",
    ].join('\n'))

    expect(records.map((record) => record.specifier)).toEqual([
      './setup', './model', './aliased', './mixed', './namespace', './values', './all', './helpers',
      './types', './runtime',
      './default-runtime', './commented',
    ])
  })

  test('rejects exported declarations and nested or dynamic import expressions', () => {
    const records = extractImports('/repo/source.ts', [
      "export const label = 'not-a-module'",
      "export function named() { return 'not-a-module' }",
      "export default 'not-a-module'",
      "export const template = `from './template-evil'`",
      "export default /from '.\\/regex-evil'/",
      "export function text() { return \"from './function-evil'\" }",
      "const nested = wrap(require('./nested'))",
      "const dynamic = import('./dynamic')",
    ].join('\n'))

    expect(records).toEqual([])
  })

  test('ignores from-like text in block and line comments', () => {
    const records = extractImports('/repo/source.ts', [
      "import { x /* from './evil-import' */ } from './real-import'",
      "export { y /* from './evil-export' */ } from './real-export'",
      "import { ignored } // from './evil-line-import'",
      "export { ignored } // from './evil-line-export'",
      "/* import './ignored-start'",
      "export { ignored } from './ignored-middle'",
      "*/ export { z } from './real-after-comment'",
    ].join('\n'))

    expect(records.map((record) => record.specifier)).toEqual([
      './real-import',
      './real-export',
      './real-after-comment',
    ])
  })

  test('does not scan beyond the current export declaration', () => {
    const records = extractImports('/repo/source.ts', [
      "export { foo }; const re = /prefix from './evil-regex'/",
      "export { foo }; const template = `prefix from './evil-template'`",
      "export { foo } from './real'; const re = /prefix from './ignored-after-real'/",
    ].join('\n'))

    expect(records.map((record) => record.specifier)).toEqual(['./real'])
  })

  test('does not scan beyond the current import declaration', () => {
    const records = extractImports('/repo/source.ts', [
      "import { foo }; const re = /prefix from './evil-regex'/",
      "import { foo }; const template = `prefix from './evil-template'`",
      "import { foo } from './real'; const re = /prefix from './ignored-after-real'/",
    ].join('\n'))

    expect(records.map((record) => record.specifier)).toEqual(['./real'])
  })
})
