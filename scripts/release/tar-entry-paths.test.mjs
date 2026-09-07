import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTarEntryPaths } from './tar-entry-paths.mjs'

test('normalizes Windows tar listing separators', () => {
  assert.deepEqual(
    normalizeTarEntryPaths('package\\package.json\r\npackage\\dist\\index.js\r\n'),
    ['package/package.json', 'package/dist/index.js'],
  )
})

test('preserves POSIX tar listing separators', () => {
  assert.deepEqual(
    normalizeTarEntryPaths('package/package.json\npackage/LICENSE\n'),
    ['package/package.json', 'package/LICENSE'],
  )
})
