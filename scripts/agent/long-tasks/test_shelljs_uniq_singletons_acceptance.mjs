import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const shell = createRequire(join(process.cwd(), 'package.json'))('./shell.js')
shell.config.silent = true
const input = 'a\na\nb\nc\nc\na\n'
function pipe(options, text = input) {
  const source = new shell.ShellString(text)
  const result = source.uniq(options)
  assert.equal(result.code, 0, 'unique-only option must be accepted')
  assert.equal(source.toString(), text)
  return result.toString()
}

test('only singleton adjacent groups survive and ordering stays intact', () => {
  assert.equal(pipe('-u'), 'b\na\n')
  assert.equal(pipe('-u', 'a\nb\na\n'), 'a\nb\na\n')
  assert.equal(pipe('-u', 'same\nsame\n'), '\n')
})

test('ignore-case comparison happens before counting and keeps representative text', () => {
  assert.equal(pipe('-iu', 'A\na\nB\nc\nC\nz\n'), 'B\nz\n')
  assert.equal(pipe('-u', 'A\na\nB\nc\nC\nz\n'), 'A\na\nB\nc\nC\nz\n')
})

test('count and duplicate flags combine without changing their established format', () => {
  assert.equal(pipe('-cu'), '      1 b\n      1 a\n')
  assert.equal(pipe('-du'), '\n')
  assert.equal(pipe('-cdu'), '\n')
  assert.equal(pipe('-ciu', 'A\na\nSolo\nb\nB\n'), '      1 Solo\n')
})

test('existing calls preserve their original results', () => {
  assert.equal(pipe(''), 'a\nb\nc\na\n')
  assert.equal(pipe('-d'), 'a\nc\n')
  assert.equal(pipe('-cd'), '      2 a\n      2 c\n')
})

test('file inputs and output files preserve inputs and output conventions', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'uniq-singletons-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'input'),
    target = join(dir, 'output')
  await fs.writeFile(source, input)
  assert.equal(shell.uniq('-u', source).toString(), 'b\na\n')
  const result = shell.uniq('-u', source, target)
  assert.equal(result.code, 0)
  assert.equal(result.toString(), '')
  assert.equal(await fs.readFile(target, 'utf8'), 'b\na\n')
  assert.equal(await fs.readFile(source, 'utf8'), input)
  const missing = shell.uniq('-u', join(dir, 'missing'))
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /No such file or directory/)
})
