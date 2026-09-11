import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { collectTextHygieneFailures, findRawControlCharacter } from './check-public-readiness.mjs'

// 夹具里的控制字符在运行时按码位生成，测试源码本身不含任何原始控制字符。
const control = (code) => String.fromCharCode(code)

test('flags raw NUL and every other C0 control character except tab, LF and CR', () => {
  assert.equal(findRawControlCharacter('a\tb\r\nc\n'), undefined)
  const joined = `const key = [a, b].join("${control(0)}")`
  assert.deepEqual(findRawControlCharacter(joined), { index: joined.indexOf(control(0)), code: 0 })
  for (const code of [0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f]) {
    assert.deepEqual(findRawControlCharacter(`x${control(code)}`), { index: 1, code }, `U+${code.toString(16)}`)
  }
})

test('escape sequences written as text are not control characters', () => {
  assert.equal(findRawControlCharacter(String.raw`const sep = "\0"; const esc = "\x1b[0m"`), undefined)
})

test('reports control characters in scanned text files, skipping binary assets and ignored directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'velaros-public-readiness-'))
  const write = (relative, content) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true })
    writeFileSync(join(root, relative), content)
  }
  try {
    write('src/separator.ts', `export const a = 1\nexport const sep = "${control(0)}"\n`)
    write('docs/terminal.md', `# Output\n\n${control(0x1b)}[31mred\n`)
    write('styles/theme.css', `.a {${control(0x0c)}}\n`)
    write('src/clean.ts', 'export const indent = 1\r\n\tconst tab = 2\n')
    write('assets/logo.png', `PNG${control(0)}${control(0x1a)}`)
    write('node_modules/pkg/index.js', `module.exports = "${control(0)}"\n`)
    write('dist/bundle.js', `var sep = "${control(0)}"\n`)

    assert.deepEqual(collectTextHygieneFailures(root).sort(), [
      'docs/terminal.md:3: raw control character U+001B (only tab, LF and CR are allowed)',
      'src/separator.ts:2: raw control character U+0000 (only tab, LF and CR are allowed)',
      'styles/theme.css:1: raw control character U+000C (only tab, LF and CR are allowed)',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
