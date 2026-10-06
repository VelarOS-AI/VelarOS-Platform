import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const shell = createRequire(join(process.cwd(), 'package.json'))('./shell.js')
shell.config.silent = true

test('unique removes exact duplicates and preserves the default behavior', () => {
  const value = shell.ShellString('b\na\nb\na\n')
  assert.equal(value.sort('-u').stdout, 'a\nb\n', 'sort unique must remove exact duplicate lines')
  assert.equal(value.stdout, 'b\na\nb\na\n')
  assert.equal(value.sort().stdout, 'a\na\nb\nb\n')
})

for (const flags of ['-u', '-nu', '-ru', '-nru']) {
  test(`${flags} uses exact strings independently of sort comparison`, () => {
    const input = '10 zoo\n2 alpha\n2 Alpha\n02 alpha\n2 alpha \n2 alpha\n10 zoo\n'
    const ordinary =
      flags === '-u'
        ? shell.ShellString(input).sort()
        : shell.ShellString(input).sort(flags.replace('u', ''))
    const expected = [...new Set(ordinary.stdout.slice(0, -1).split('\n'))].join('\n') + '\n'
    const result = shell.ShellString(input).sort(flags)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, expected)
    assert(result.stdout.includes('2 Alpha\n'))
    assert(result.stdout.includes('02 alpha\n'))
  })
}

test('multiple files, arrays and pipelines share the command without modifying inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sort-unique-grade-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const a = join(directory, 'a.txt'),
    b = join(directory, 'b.txt')
  await writeFile(a, 'c\na\nc\n')
  await writeFile(b, 'b\na\n')
  for (const result of [
    shell.sort('-u', a, b),
    shell.sort('-u', [a, b]),
    shell.cat(a, b).sort('-u'),
  ]) {
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'a\nb\nc\n')
  }
  assert.equal(await readFile(a, 'utf8'), 'c\na\nc\n')
  assert.equal(await readFile(b, 'utf8'), 'b\na\n')
  const failed = shell.sort('-u', a, join(directory, 'missing'))
  assert.equal(failed.code, 1)
  assert.match(failed.stderr, /no such file or directory/)
})
