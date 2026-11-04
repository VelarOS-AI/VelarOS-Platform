import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { scripts } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
)

test('default and release checks use the bounded fast gate', () => {
  assert.equal(scripts.check, 'node scripts/quality/run-fast-check.mjs')
  assert.equal(scripts['check:fast'], scripts.check)
  assert.equal(scripts['release:check'], 'bun run check')
  assert.match(scripts['check:full'], /test:built/u)
  assert.match(scripts['check:full'], /check:gates:remaining/u)
})
