import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { scripts } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
)
const groups = new Set(['release:preflight', 'check:gates', 'check:gates:remaining'])
const expand = (command) =>
  command.split(' && ').flatMap((part) => {
    const name = part.replace('bun run ', '')
    return groups.has(name) ? expand(scripts[name]) : [name]
  })

test('release fails fast before build without repeating early checks', () => {
  const checks = expand(scripts.check)
  for (const name of [
    'check:format',
    'check:project-arch',
    'check:lockfile-consistency',
    'check:platform-generation',
    'check:package-catalog',
  ]) {
    assert.equal(checks.filter((item) => item === name).length, 1, name)
    assert.ok(checks.indexOf(name) < checks.indexOf('build'), name)
  }
  for (const name of [
    'build',
    'typecheck',
    'lint',
    'test:built',
    'test:suites',
    ...expand(scripts['check:gates']),
  ]) {
    assert.ok(checks.includes(name), name)
  }
})
