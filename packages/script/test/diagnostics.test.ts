import { expect, test } from 'bun:test'

import { codeProgramChecker } from '../src/index.js'

const endings = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r'],
  ['LS', '\u2028'],
  ['PS', '\u2029'],
] as const

for (const [name, ending] of endings) {
  test(`公开检查器的 ${name} 行列与代码帧一致，原文保持不变`, () => {
    const source = `const first = 1;${ending}const second = ;`
    const input = { source, granted: [] }
    const bytes = Buffer.from(source)
    const result = codeProgramChecker.check(input)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('语法错误应由公开检查器拒绝')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      line: 2,
      column: 16,
      code: 1109,
      frame: '2 | const second = ;\n  |                ^',
    })
    expect(input.source).toBe(source)
    expect(Buffer.from(input.source)).toEqual(bytes)
  })
}

test('混合行结束、连续空行及末尾换行保持实际行号', () => {
  const result = codeProgramChecker.check({
    source: 'const first = 1;\r\n\rconst tag = "🧪";\u2028\u2029const second = ;\n',
    granted: [],
  })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('混合换行中的语法错误应被拒绝')
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({
    line: 5,
    column: 16,
    frame: '5 | const second = ;\n  |                ^',
  })
})

test('合法混合换行程序原样通过，不产生替换执行源码', () => {
  const source = 'const first = 1;\r\n\rconst tag = "🧪";\u2028\u2029export { first, tag };\n'
  const input = { source, granted: [] }
  const bytes = Buffer.from(source)
  expect(codeProgramChecker.check(input)).toEqual({ ok: true })
  expect(input.source).toBe(source)
  expect(Buffer.from(input.source)).toEqual(bytes)
})

test('最后一个空行上的缺失闭括号保留 EOF 定位', () => {
  const result = codeProgramChecker.check({ source: 'function open() {\r\n\u2028', granted: [] })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('未闭合函数应被拒绝')
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({
    line: 3,
    column: 1,
    code: 1005,
    frame: '3 | \n  | ^',
  })
})

test('Unicode 和制表符之前的列定位仍按 UTF-16 原文计算', () => {
  const line = '\tconst label = "😀"; const second = ;'
  const result = codeProgramChecker.check({ source: `const first = 1;\r${line}`, granted: [] })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Unicode 行中的语法错误应被拒绝')
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({
    line: 2,
    column: line.lastIndexOf(';') + 1,
    frame: `2 | ${line}\n  | ${' '.repeat(line.lastIndexOf(';'))}^`,
  })
})

test('长行截断不改变原始错误列，代码帧插字符仍有界', () => {
  const line = `${' '.repeat(210)}const second = ;`
  const result = codeProgramChecker.check({ source: `const first = 1;\u2029${line}`, granted: [] })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('长行语法错误应被拒绝')
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({
    line: 2,
    column: 226,
    frame: `2 | ${' '.repeat(200)}…\n  | ${' '.repeat(201)}^`,
  })
})

test('长行中可见的错误定位保留，截断发生在错误之后', () => {
  const line = `const second = ; // ${'x'.repeat(240)}`
  const result = codeProgramChecker.check({ source: `const first = 1;\u2028${line}`, granted: [] })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('注释前的语法错误应被拒绝')
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({
    line: 2,
    column: 16,
    frame: `2 | const second = ; // ${'x'.repeat(180)}…\n  |                ^`,
  })
})

test('附属模块的混合换行错误保留文件身份和源码帧', () => {
  const result = codeProgramChecker.check({
    source: "import './lib/fixture.js';",
    granted: [],
    modules: { 'lib/fixture.js': 'export const first = 1;\r\n\u2029export const second = ;' },
  })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('附属模块语法错误应被拒绝')
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]).toMatchObject({
    file: 'lib/fixture.js',
    line: 3,
    column: 23,
    frame: '3 | export const second = ;\n  |                       ^',
  })
})
