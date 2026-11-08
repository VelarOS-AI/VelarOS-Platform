import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, expect, test } from 'bun:test'

import { testScriptRunsFile } from '../../scripts/ownership/test-entrypoints.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 每例使用真实目录、测试文件和邻名目录，不执行夹具脚本。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'velaros-test-entrypoints-'))
  roots.push(root)
  for (const file of [
    'browser/test/nested/new.test.ts',
    'browser/test/stream.spec.mjs',
    'browser/test-old/missed.test.ts',
    'browser/test/not-a-test.ts',
    'test files/quoted.test.ts',
    'spec/acceptance.test.ts',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

test('Bun directory arguments cover nested tests using path components', () => {
  const root = fixture()
  const script = 'bun run build && bun test browser/test spec/acceptance.test.ts'
  expect(testScriptRunsFile(root, script, 'browser/test/nested/new.test.ts')).toBe(true)
  expect(testScriptRunsFile(root, script, 'browser/test/stream.spec.mjs')).toBe(true)
  expect(testScriptRunsFile(root, script, 'spec/acceptance.test.ts')).toBe(true)
  expect(testScriptRunsFile(root, script, 'browser/test-old/missed.test.ts')).toBe(false)
  expect(testScriptRunsFile(root, 'bun test', 'browser/test/nested/new.test.ts')).toBe(true)
  expect(
    testScriptRunsFile(
      root,
      'bun test browser/test # current tests',
      'browser/test/nested/new.test.ts'
    )
  ).toBe(true)
})

test('literal quoted paths and current Node file arguments remain executable evidence', () => {
  const root = fixture()
  for (const script of [
    'bun test --timeout 30000 "test files/quoted.test.ts"',
    "bun test --timeout=30000 'test files/quoted.test.ts'",
    'node --test --test-concurrency=4 "test files/quoted.test.ts"',
  ])
    expect(testScriptRunsFile(root, script, 'test files/quoted.test.ts')).toBe(true)
  expect(
    testScriptRunsFile(root, 'node --test browser/test', 'browser/test/nested/new.test.ts')
  ).toBe(false)
})

test('comments, quoted command text, partial names and unknown execution semantics do not prove coverage', () => {
  const root = fixture()
  for (const script of [
    '# bun test browser/test',
    'echo "bun test browser/test"',
    'node -e "console.log(\'bun test browser/test\')"',
    'bun test browser/test-old',
    'bun test browser/tes',
    'bun test --test-name-pattern INV-1 browser/test',
    'node --test --test-name-pattern INV-1 browser/test/nested/new.test.ts',
    'bun test --unknown browser/test',
    'cd browser && bun test test',
    'eval command && bun test browser/test',
    'true || bun test browser/test',
    'if true; then bun test browser/test; fi',
    'bun test "$TEST_DIRECTORY"',
    'bun test browser/test &&',
  ])
    expect(testScriptRunsFile(root, script, 'browser/test/nested/new.test.ts')).toBe(false)
})

test('coverage requires a real test file inside the package, excluding ignored dependency trees', () => {
  const root = fixture()
  expect(testScriptRunsFile(root, 'bun test browser/test', 'browser/test/missing.test.ts')).toBe(
    false
  )
  expect(testScriptRunsFile(root, 'bun test browser/test', 'browser/test/not-a-test.ts')).toBe(
    false
  )
  expect(testScriptRunsFile(root, 'bun test browser/test', 'browser/test/nested')).toBe(false)
  mkdirSync(join(root, 'node_modules/private'), { recursive: true })
  writeFileSync(join(root, 'node_modules/private/hidden.test.ts'), '')
  expect(testScriptRunsFile(root, 'bun test', 'node_modules/private/hidden.test.ts')).toBe(false)
  const outside = fixture()
  symlinkSync(outside, join(root, 'linked-tests'), 'junction')
  expect(
    testScriptRunsFile(root, 'bun test linked-tests', join(outside, 'spec/acceptance.test.ts'))
  ).toBe(false)
  expect(
    testScriptRunsFile(root, 'bun test linked-tests', 'linked-tests/spec/acceptance.test.ts')
  ).toBe(false)
  const alias = join(outside, 'package-alias')
  symlinkSync(root, alias, 'junction')
  expect(
    testScriptRunsFile(
      alias,
      'bun test browser/test',
      join(alias, 'browser/test/nested/new.test.ts')
    )
  ).toBe(true)
})

test('Model test directory already covers both reasoning regressions in each real test entry', () => {
  const root = resolve(import.meta.dir, '../../packages/model')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const script of [manifest.scripts.test, manifest.scripts['test:built']]) {
    for (const file of ['test/chat-reasoning.test.ts', 'test/reasoning-levels.test.ts']) {
      expect(script.includes(file)).toBe(false)
      expect(testScriptRunsFile(root, script, file)).toBe(true)
    }
  }
})
