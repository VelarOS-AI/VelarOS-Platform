import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { findJsTsSymbols, type JsTsSymbol } from '../src/adapters/jsts-ast'
import type { EditOperation, ProjectPlugin } from '../src/index'
import { createProjectKernel, typescriptPlugin } from '../src/index'

// 符号范围一律来自 TypeScript AST：这些形态都曾让「正则 + 朴素括号计数」把范围截断在签名或
// 函数体中间，replace_symbol 于是只替换半个声明——语法恰好还合法时就是静默改坏代码。

function symbolText(content: string, symbol: JsTsSymbol): string {
  return content.slice(symbol.range.startOffset, symbol.range.endOffset)
}

function only(content: string, query: { name: string; kind?: string; container?: string }, path = 'a.ts'): JsTsSymbol {
  const matches = findJsTsSymbols(content, path, query)
  expect(matches).toHaveLength(1)
  return matches[0]
}

const ObjectTypedParameter = [
  'async function applyEdit(',
  '  input: {',
  '    operations: string[]',
  '    cwd?: string',
  '  },',
  '  context: number',
  ') {',
  '  return input.operations.length + context',
  '}',
].join('\n')

const RegexWithBraces = [
  'function removeImport(statement: string) {',
  '  const match = statement.match(/\\{([^}]*)\\}/)',
  "  return match ? match[1] : ''",
  '}',
].join('\n')

const TemplateWithObject = [
  'function render(name: string) {',
  '  return `${ { name }.name }-${ `{` }`',
  '}',
].join('\n')

const SignatureObjects = [
  'export function build<T = { a: 1 }>(options = { retries: 3 }): { ok: boolean; value?: T } {',
  '  return { ok: options.retries > 0 }',
  '}',
].join('\n')

const ClassMembers = [
  'function track(_target: unknown, _key: string) {}',
  '',
  '@sealed',
  'export class Service {',
  '  @track',
  '  static async create(config: { url: string }) {',
  '    return new Service(config.url)',
  '  }',
  '',
  '  constructor(private readonly url: string) {}',
  '',
  '  get endpoint() {',
  '    return `${this.url}/api`',
  '  }',
  '',
  '  set endpoint(value: string) {}',
  '',
  '  handle = async (event: { type: string }) => {',
  '    return event.type',
  '  }',
  '}',
  '',
  'function sealed(_target: unknown) {}',
].join('\n')

describe('JS/TS AST symbol ranges', () => {
  test('spans the whole declaration when parameters carry object type literals', () => {
    const content = `${ObjectTypedParameter}\n`
    expect(symbolText(content, only(content, { name: 'applyEdit' }))).toBe(ObjectTypedParameter)
  })

  test('is not fooled by braces inside regex literals or template strings', () => {
    const content = `${RegexWithBraces}\n\n${TemplateWithObject}\n`
    expect(symbolText(content, only(content, { name: 'removeImport' }))).toBe(RegexWithBraces)
    expect(symbolText(content, only(content, { name: 'render' }))).toBe(TemplateWithObject)
  })

  test('keeps generic defaults, default parameter objects, and object return types inside the signature', () => {
    const content = `${SignatureObjects}\n`
    const symbol = only(content, { name: 'build', kind: 'function' })
    expect(symbolText(content, symbol)).toBe(SignatureObjects)
    expect(content.slice(symbol.bodyRange?.startOffset, symbol.bodyRange?.endOffset)).toBe(
      '\n  return { ok: options.retries > 0 }\n'
    )
  })

  test('treats const arrow functions and function expressions as functions with AST body ranges', () => {
    const content = [
      'export const block = async (input: { id: string }) => {',
      '  return input.id',
      '};',
      'export const expression = (value: number) => ({ value });',
      'const legacy = function (flag = {}) { return flag };',
      'export const a = 1, b = () => 2;',
      '',
    ].join('\n')
    const block = only(content, { name: 'block', kind: 'function' })
    expect(symbolText(content, block)).toBe('export const block = async (input: { id: string }) => {\n  return input.id\n};')
    const expression = only(content, { name: 'expression' })
    expect(content.slice(expression.bodyRange?.startOffset, expression.bodyRange?.endOffset)).toBe('({ value })')
    expect(only(content, { name: 'legacy' }).kind).toBe('function')
    // 多声明语句里每个绑定取自身声明范围，互不牵连。
    expect(symbolText(content, only(content, { name: 'a', kind: 'variable' }))).toBe('a = 1')
    expect(symbolText(content, only(content, { name: 'b', kind: 'function' }))).toBe('b = () => 2')
  })

  test('models class members as methods contained by the class, decorators included', () => {
    const content = `${ClassMembers}\n`
    const service = only(content, { name: 'Service', kind: 'class' })
    expect(symbolText(content, service).startsWith('@sealed\nexport class Service {')).toBe(true)
    expect(symbolText(content, service).endsWith('    return event.type\n  }\n}')).toBe(true)

    const create = only(content, { name: 'create', container: 'Service' })
    expect(create.kind).toBe('method')
    expect(symbolText(content, create)).toBe(
      '@track\n  static async create(config: { url: string }) {\n    return new Service(config.url)\n  }'
    )
    expect(only(content, { name: 'constructor', container: 'Service' }).kind).toBe('method')
    expect(findJsTsSymbols(content, 'a.ts', { name: 'endpoint', container: 'Service' })).toHaveLength(2)
    expect(symbolText(content, only(content, { name: 'handle', kind: 'method' }))).toBe(
      'handle = async (event: { type: string }) => {\n    return event.type\n  }'
    )
  })

  test('covers export default functions, overloads, and TypeScript-only declarations', () => {
    const content = [
      '/** 文档注释不属于符号范围。 */',
      'export default function handler(request: { url: string }) {',
      '  return request.url',
      '}',
      'export function parse(value: string): number',
      'export function parse(value: number): number',
      'export function parse(value: unknown): number {',
      '  return Number(value)',
      '}',
      'export interface Options { retries: number }',
      'export type Mode = { kind: "a" } | { kind: "b" }',
      'export const enum Level { Low, High }',
      'export namespace Tools { export function run() {} }',
      '',
    ].join('\n')
    const handler = only(content, { name: 'handler' })
    expect(symbolText(content, handler).startsWith('export default function handler(')).toBe(true)
    expect(handler.exported).toBe(true)
    // 重载签名与实现合并为一个符号：whole 替换连同签名一起换掉。
    const parse = only(content, { name: 'parse' })
    expect(symbolText(content, parse).startsWith('export function parse(value: string): number\n')).toBe(true)
    expect(symbolText(content, parse).endsWith('return Number(value)\n}')).toBe(true)
    expect(only(content, { name: 'Options' }).kind).toBe('interface')
    expect(symbolText(content, only(content, { name: 'Mode' }))).toBe('export type Mode = { kind: "a" } | { kind: "b" }')
    expect(only(content, { name: 'Level' }).kind).toBe('enum')
    expect(only(content, { name: 'run', container: 'Tools' }).kind).toBe('function')
    expect(findJsTsSymbols('export default function () {}\n', 'a.ts', { name: 'default' })).toHaveLength(1)
  })

  test('accessors stay methods; getter / setter queries split a get/set pair', () => {
    const content = 'class C {\n  get v() { return 1 }\n  set v(x: number) {}\n  run() {}\n}\n'
    const accessors = findJsTsSymbols(content, 'a.ts', { name: 'v', container: 'C' })
    expect(accessors.map((symbol) => [symbol.kind, symbol.metadata.accessor])).toEqual([
      ['method', 'get'],
      ['method', 'set'],
    ])
    expect(findJsTsSymbols(content, 'a.ts', { kind: 'method', container: 'C' }).map((symbol) => symbol.name)).toEqual(['v', 'v', 'run'])
    expect(symbolText(content, only(content, { name: 'v', kind: 'getter' }))).toBe('get v() { return 1 }')
    expect(symbolText(content, only(content, { name: 'v', kind: 'setter' }))).toBe('set v(x: number) {}')
    expect(only(content, { name: 'run', container: 'C' }).metadata).toEqual({ exported: false })
  })

  test('braced declarations expose the text between their own braces as the body', () => {
    const content = [
      'export class Box<T extends { id: string } = { id: "" }> implements Iterable<{ v: T }> {',
      '  value = 1',
      '}',
      'interface Shape extends Record<string, { n: number }> { area: number }',
      'enum Level { Low, High }',
      'namespace Outer.Inner { export const x = 1 }',
      'type Literal = { a: string }',
      'type Union = { a: string } | { b: string }',
      '',
    ].join('\n')
    const body = (query: { name: string; kind?: string }) => {
      const range = only(content, query).bodyRange
      return range ? content.slice(range.startOffset, range.endOffset) : undefined
    }
    expect(body({ name: 'Box' })).toBe('\n  value = 1\n')
    expect(body({ name: 'Shape' })).toBe(' area: number ')
    expect(body({ name: 'Level' })).toBe(' Low, High ')
    expect(body({ name: 'Outer' })).toBe(' export const x = 1 ')
    expect(body({ name: 'Literal' })).toBe(' a: string ')
    // 联合类型没有唯一的一对括号，不给 body，mode=body 会显式失败。
    expect(body({ name: 'Union' })).toBeUndefined()
  })

  test('kind function falls back to methods only when no function of that name exists', () => {
    const content = 'class A {\n  run() {}\n}\nclass B {\n  stop() {}\n}\nfunction run() {}\n'
    expect(findJsTsSymbols(content, 'a.ts', { name: 'run', kind: 'function' }).map((symbol) => symbol.kind)).toEqual([
      'function',
    ])
    expect(findJsTsSymbols(content, 'a.ts', { name: 'stop', kind: 'function' }).map((symbol) => symbol.container)).toEqual([
      'B',
    ])
  })
})

const KernelVariants: Array<{ label: string; plugins: ProjectPlugin[] }> = [
  { label: 'core plugin only', plugins: [] },
  { label: 'with typescript plugin', plugins: [typescriptPlugin()] },
]

async function withProject<T>(
  plugins: ProjectPlugin[],
  files: Record<string, string>,
  run: (project: Awaited<ReturnType<typeof createProjectKernel>>, read: (path: string) => Promise<string>) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-jsts-'))
  try {
    for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content)
    const project = await createProjectKernel({ root, plugins })
    return await run(project, (path) => readFile(join(root, path), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const variant of KernelVariants) {
  describe(`JS/TS symbol edits end to end (${variant.label})`, () => {
    const edit = async (content: string, operation: EditOperation, path = 'a.ts') =>
      withProject(variant.plugins, { [path]: content }, async (project, read) => {
        const transaction = await project.prepareEdit({ operations: [{ operation }] })
        await project.applyEdit({ transactionId: transaction.transactionId })
        return read(path)
      })

    test('replace_symbol whole swaps the entire object-typed signature', async () => {
      const replacement = 'async function applyEdit(input: { operations: string[] }, context: number) {\n  return context\n}'
      const next = await edit(`${ObjectTypedParameter}\n\nexport const tail = 1\n`, {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { kind: 'function', name: 'applyEdit' },
        replacement,
        mode: 'whole',
      })
      expect(next).toBe(`${replacement}\n\nexport const tail = 1\n`)
    })

    test('replace_symbol whole handles functions whose bodies contain brace-bearing regex literals', async () => {
      const replacement = 'function removeImport(statement: string) {\n  return statement.trim()\n}'
      const next = await edit(`${RegexWithBraces}\n\n${TemplateWithObject}\n`, {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { name: 'removeImport' },
        replacement,
      })
      expect(next).toBe(`${replacement}\n\n${TemplateWithObject}\n`)
    })

    test('replace_symbol body keeps generic defaults, default objects, and object return types intact', async () => {
      const next = await edit(`${SignatureObjects}\n`, {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { kind: 'function', name: 'build' },
        replacement: '\n  return { ok: false }\n',
        mode: 'body',
      })
      expect(next).toBe(
        'export function build<T = { a: 1 }>(options = { retries: 3 }): { ok: boolean; value?: T } {\n  return { ok: false }\n}\n'
      )
    })

    test('replace_symbol body replaces an expression-bodied arrow function body', async () => {
      const next = await edit('export const double = (value: number) => value * 2\n', {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { name: 'double' },
        replacement: '{\n  return value + value\n}',
        mode: 'body',
      })
      expect(next).toBe('export const double = (value: number) => {\n  return value + value\n}\n')
    })

    test('replace_symbol targets class methods, accessors are disambiguated by container', async () => {
      const next = await edit(`${ClassMembers}\n`, {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { kind: 'function', name: 'create', container: 'Service' },
        replacement: '\n    return new Service(config.url.trim())\n  ',
        mode: 'body',
      })
      expect(next).toContain('  @track\n  static async create(config: { url: string }) {\n    return new Service(config.url.trim())\n  }\n')
      expect(next).toContain('handle = async (event: { type: string }) => {')
    })

    test('replace_symbol through a resolved target reuses the AST body range', async () => {
      await withProject(variant.plugins, { 'a.ts': `${ClassMembers}\n` }, async (project, read) => {
        const resolved = await project.resolveTarget({
          path: 'a.ts',
          target: { symbol: { kind: 'method', name: 'handle', container: 'Service' } },
          expectedMatches: 1,
        })
        expect(resolved.status).toBe('resolved')
        if (resolved.status !== 'resolved') return
        const transaction = await project.prepareEdit({
          operations: [{
            targetId: resolved.target.targetId,
            operation: { type: 'replace_symbol', replacement: '\n    return event.type.toUpperCase()\n  ', mode: 'body' },
          }],
        })
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await read('a.ts')).toContain('handle = async (event: { type: string }) => {\n    return event.type.toUpperCase()\n  }\n}')
      })
    })

    test('replace_symbol whole on an export default function and a multi-declaration binding', async () => {
      const defaultNext = await edit('/** 入口 */\nexport default function handler() {\n  return { ok: true }\n}\n', {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { name: 'handler' },
        replacement: 'export default function handler() {\n  return { ok: false }\n}',
      })
      expect(defaultNext).toBe('/** 入口 */\nexport default function handler() {\n  return { ok: false }\n}\n')

      const multiNext = await edit('export const first = { a: 1 }, second = { b: 2 };\n', {
        type: 'replace_symbol',
        path: 'a.ts',
        symbol: { name: 'first' },
        replacement: 'first = { a: 100 }',
      })
      expect(multiNext).toBe('export const first = { a: 100 }, second = { b: 2 };\n')
    })

    test('insert_around_symbol lands exactly before and after the AST declaration', async () => {
      const before = await edit(`${ObjectTypedParameter}\n`, {
        type: 'insert_around_symbol',
        path: 'a.ts',
        symbol: { name: 'applyEdit' },
        position: 'before',
        text: '// 应用编辑\n',
      })
      expect(before).toBe(`// 应用编辑\n${ObjectTypedParameter}\n`)

      const after = await edit(`${RegexWithBraces}\n`, {
        type: 'insert_around_symbol',
        path: 'a.ts',
        symbol: { name: 'removeImport' },
        position: 'after',
        text: '\n\nexport const marker = 1',
      })
      expect(after).toBe(`${RegexWithBraces}\n\nexport const marker = 1\n`)
    })

    test('insertions next to a binding of a multi-declaration land on the statement boundary', async () => {
      const content = 'const a = 1, b = 2;\nexport const sum = a + b\n'
      expect(await edit(content, { type: 'insert_after_symbol', path: 'a.ts', symbol: { name: 'a' }, text: '\nconsole.log(a)' })).toBe(
        'const a = 1, b = 2;\nconsole.log(a)\nexport const sum = a + b\n'
      )
      expect(await edit(content, { type: 'insert_before_symbol', path: 'a.ts', symbol: { name: 'b' }, text: '// 前置\n' })).toBe(
        '// 前置\nconst a = 1, b = 2;\nexport const sum = a + b\n'
      )
      await withProject(variant.plugins, { 'a.ts': content }, async (project, read) => {
        const resolved = await project.resolveTarget({ path: 'a.ts', target: { symbol: { name: 'a' } }, expectedMatches: 1 })
        expect(resolved.status).toBe('resolved')
        if (resolved.status !== 'resolved') return
        const transaction = await project.prepareEdit({
          operations: [{
            targetId: resolved.target.targetId,
            operation: { type: 'insert_around_symbol', position: 'after', text: '\nconsole.log(a)' },
          }],
        })
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await read('a.ts')).toBe('const a = 1, b = 2;\nconsole.log(a)\nexport const sum = a + b\n')
      })
    })

    test('replace_symbol body works on classes, interfaces, and enums, and fails loudly without braces', async () => {
      expect(await edit('export class Box {\n  value = 1\n}\n', {
        type: 'replace_symbol', path: 'a.ts', symbol: { name: 'Box' }, replacement: '\n  value = 2\n', mode: 'body',
      })).toBe('export class Box {\n  value = 2\n}\n')
      expect(await edit('interface Shape { area: number }\nenum Level { Low }\n', {
        type: 'replace_symbol', path: 'a.ts', symbol: { name: 'Level' }, replacement: ' Low, High ', mode: 'body',
      })).toBe('interface Shape { area: number }\nenum Level { Low, High }\n')
      await withProject(variant.plugins, { 'a.ts': 'type Union = { a: string } | { b: string }\n' }, async (project) => {
        await expect(project.prepareEdit({
          operations: [{ operation: { type: 'replace_symbol', path: 'a.ts', symbol: { name: 'Union' }, replacement: 'x', mode: 'body' } }],
        })).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND' })
      })
    })

    test('replace_symbol picks one accessor of a get/set pair by getter / setter kind', async () => {
      const content = 'class C {\n  get v() { return 1 }\n  set v(x: number) {}\n}\n'
      expect(await edit(content, {
        type: 'replace_symbol', path: 'a.ts', symbol: { name: 'v', kind: 'setter', container: 'C' }, replacement: ' void x ', mode: 'body',
      })).toBe('class C {\n  get v() { return 1 }\n  set v(x: number) { void x }\n}\n')
      await withProject(variant.plugins, { 'a.ts': content }, async (project) => {
        await expect(project.prepareEdit({
          operations: [{ operation: { type: 'replace_symbol', path: 'a.ts', symbol: { name: 'v' }, replacement: 'x' } }],
        })).rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET', details: { candidates: ['method C.v（get，第 2 行）', 'method C.v（set，第 3 行）'] } })
        const symbols = await project.listSymbols('a.ts')
        expect(symbols.filter((symbol) => symbol.name === 'v').map((symbol) => symbol.kind)).toEqual(['method', 'method'])
      })
    })

    test('replace_symbol body never guesses a body for non-JS/TS targets', async () => {
      const files = {
        'a.py': 'def load():\n    cfg = {\n        "a": 1\n    }\n    return cfg\n',
        'a.go': 'package a\n\nfunc f() {\n  s := "}"\n  _ = s\n}\n',
      }
      await withProject(variant.plugins, files, async (project, read) => {
        for (const [path, name] of [['a.py', 'load'], ['a.go', 'f']] as const) {
          const resolved = await project.resolveTarget({ path, target: { symbol: { name } }, expectedMatches: 1 })
          expect(resolved.status).toBe('resolved')
          if (resolved.status !== 'resolved') continue
          await expect(project.prepareEdit({
            operations: [{ targetId: resolved.target.targetId, operation: { type: 'replace_symbol', replacement: '  x()\n', mode: 'body' } }],
          })).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND' })
          expect(await read(path)).toBe(files[path])
        }
      })
    })

    test('ambiguous symbol selectors fail closed and list the candidates', async () => {
      await withProject(variant.plugins, { 'a.ts': 'class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n' }, async (project, read) => {
        await expect(project.prepareEdit({
          operations: [{ operation: { type: 'replace_symbol', path: 'a.ts', symbol: { name: 'run' }, replacement: 'run() {}' } }],
        })).rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET', details: { candidates: ['method A.run（第 2 行）', 'method B.run（第 5 行）'] } })
        expect(await read('a.ts')).toBe('class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n')
      })
    })
  })

  describe(`JS/TS import mutations (${variant.label})`, () => {
    const mutate = async (content: string, operation: EditOperation) =>
      withProject(variant.plugins, { 'a.ts': content }, async (project, read) => {
        const transaction = await project.prepareEdit({ operations: [{ operation }] })
        await project.applyEdit({ transactionId: transaction.transactionId })
        return read('a.ts')
      })
    const MultiLine = "import {\n  alpha,\n  beta as renamed,\n  type Gamma,\n} from './lib'\n\nexport const value = alpha\n"

    test('removes a middle, an aliased, and an inline type binding from a multi-line import', async () => {
      expect(await mutate(MultiLine, { type: 'remove_import', path: 'a.ts', module: './lib', name: 'alpha' })).toBe(
        "import {\n  beta as renamed,\n  type Gamma,\n} from './lib'\n\nexport const value = alpha\n"
      )
      expect(await mutate(MultiLine, { type: 'remove_import', path: 'a.ts', moduleSpecifier: './lib', name: 'beta' })).toBe(
        "import {\n  alpha,\n  type Gamma,\n} from './lib'\n\nexport const value = alpha\n"
      )
      expect(await mutate(MultiLine, { type: 'remove_import', path: 'a.ts', module: './lib', name: 'Gamma' })).toBe(
        "import {\n  alpha,\n  beta as renamed,\n} from './lib'\n\nexport const value = alpha\n"
      )
    })

    test('removing the last named binding drops the statement, or keeps the default binding', async () => {
      expect(await mutate("import { only } from './lib'\nexport const x = 1\n", {
        type: 'remove_import', path: 'a.ts', module: './lib', name: 'only',
      })).toBe('export const x = 1\n')
      expect(await mutate("import Lib, {\n  only,\n} from './lib'\nexport const x = Lib\n", {
        type: 'remove_import', path: 'a.ts', module: './lib', name: 'only',
      })).toBe("import Lib from './lib'\nexport const x = Lib\n")
      expect(await mutate("import Lib, { only } from './lib'\nexport const x = only\n", {
        type: 'remove_import', path: 'a.ts', module: './lib', name: 'Lib',
      })).toBe("import { only } from './lib'\nexport const x = only\n")
    })

    test('removes namespace and side-effect imports by module', async () => {
      expect(await mutate("import * as path from 'node:path'\nimport './setup'\nexport const x = 1\n", {
        type: 'remove_import', path: 'a.ts', module: 'node:path', name: 'path',
      })).toBe("import './setup'\nexport const x = 1\n")
      expect(await mutate("import * as path from 'node:path'\nimport './setup'\nexport const x = 1\n", {
        type: 'remove_import', path: 'a.ts', moduleSpecifier: './setup',
      })).toBe("import * as path from 'node:path'\nexport const x = 1\n")
    })

    test('removes an exact import statement regardless of quote style and whitespace', async () => {
      expect(await mutate("import {a,b} from \"./lib\";\nimport { c } from './lib'\nexport const x = 1\n", {
        type: 'remove_import', path: 'a.ts', importStatement: "import { b, a } from './lib'",
      })).toBe("import { c } from './lib'\nexport const x = 1\n")
    })

    test('refuses to guess between several declarations of the same module', async () => {
      const content = "import { a } from './lib'\nimport type { B } from './lib'\nexport const x = a\n"
      await withProject(variant.plugins, { 'a.ts': content }, async (project, read) => {
        await expect(project.prepareEdit({
          operations: [{ operation: { type: 'remove_import', path: 'a.ts', module: './lib' } }],
        })).rejects.toMatchObject({
          reason: 'AMBIGUOUS_TARGET',
          details: { candidates: ["import { a } from './lib'", "import type { B } from './lib'"] },
          suggestedNextAction: expect.stringContaining('importStatement'),
        })
        // 只有一条声明含该 binding 时仍能唯一确定。
        const transaction = await project.prepareEdit({
          operations: [{ operation: { type: 'remove_import', path: 'a.ts', module: './lib', name: 'B' } }],
        })
        await project.applyEdit({ transactionId: transaction.transactionId })
        expect(await read('a.ts')).toBe("import { a } from './lib'\nexport const x = a\n")
      })
    })

    test('reports a missing binding as TARGET_NOT_FOUND without touching the file', async () => {
      await withProject(variant.plugins, { 'a.ts': MultiLine }, async (project) => {
        await expect(project.prepareEdit({
          operations: [{ operation: { type: 'remove_import', path: 'a.ts', module: './lib', name: 'delta' } }],
        })).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND' })
      })
    })

    test('merges missing named bindings into an existing multi-line import', async () => {
      expect(await mutate(MultiLine, { type: 'add_import', path: 'a.ts', module: './lib', named: ['alpha', 'delta', 'epsilon as eps'] })).toBe(
        "import {\n  alpha,\n  beta as renamed,\n  type Gamma,\n  delta,\n  epsilon as eps,\n} from './lib'\n\nexport const value = alpha\n"
      )
      expect(await mutate("import { a } from './lib'\nexport const x = a\n", {
        type: 'add_import', path: 'a.ts', module: './lib', defaultImport: 'Lib', named: ['b'],
      })).toBe("import Lib, { a, b } from './lib'\nexport const x = a\n")
    })

    test('appends new imports after the last import in the file style, keeping shebang and directives first', async () => {
      expect(await mutate("import { a } from './a'\n\nexport const x = a\n", {
        type: 'add_import', path: 'a.ts', module: 'node:path', namespaceImport: 'path',
      })).toBe("import { a } from './a'\nimport * as path from 'node:path'\n\nexport const x = a\n")
      expect(await mutate("#!/usr/bin/env node\n'use strict'\nexport const x = 1\n", {
        type: 'add_import', path: 'a.ts', module: './polyfill', sideEffectOnly: true,
      })).toBe("#!/usr/bin/env node\n'use strict'\nimport \"./polyfill\";\nexport const x = 1\n")
    })

    test('keeps CRLF line endings and per-line comments attached to their bindings', async () => {
      expect(await mutate('import a from "a";\r\nconst x = a;\r\n', {
        type: 'add_import', path: 'a.ts', module: 'b', named: ['c'],
      })).toBe('import a from "a";\r\nimport { c } from "b";\r\nconst x = a;\r\n')
      expect(await mutate("import {\n  a, // first\n  b // second\n} from 'x'\nexport const y = a\n", {
        type: 'add_import', path: 'a.ts', module: 'x', named: ['c'],
      })).toBe("import {\n  a, // first\n  b, // second\n  c\n} from 'x'\nexport const y = a\n")
      expect(await mutate("import { gone } from 'x' // 只为副作用\nexport const y = 1\n", {
        type: 'remove_import', path: 'a.ts', module: 'x', name: 'gone',
      })).toBe('export const y = 1\n')
    })

    test('deduplicates add_import into an explicit noop patch', async () => {
      await withProject(variant.plugins, { 'a.ts': MultiLine }, async (project, read) => {
        const statement = await project.prepareEdit({
          operations: [{ operation: { type: 'add_import', path: 'a.ts', importStatement: 'import { type Gamma, alpha, beta as renamed } from "./lib"' } }],
        })
        expect(statement.patches[0]?.metadata).toMatchObject({ noop: true })
        const named = await project.prepareEdit({
          operations: [{ operation: { type: 'add_import', path: 'a.ts', module: './lib', named: ['alpha'] } }],
        })
        expect(named.patches[0]?.metadata).toMatchObject({ noop: true })
        await project.applyEdit({ transactionId: named.transactionId })
        expect(await read('a.ts')).toBe(MultiLine)
      })
    })

    test('type-only bindings never satisfy a value import; they are promoted in place instead', async () => {
      const tail = 'export const v = 1\n'
      const add = (head: string, operation: Omit<Extract<EditOperation, { type: 'add_import' }>, 'type' | 'path'>) =>
        mutate(`${head}\n${tail}`, { type: 'add_import', path: 'a.ts', ...operation })
      expect(await add("import type { A } from './x'", { module: './x', named: ['A'] })).toBe(`import { A } from './x'\n${tail}`)
      expect(await add("import type { A, B } from './x'", { module: './x', named: ['A'] })).toBe(`import { A, type B } from './x'\n${tail}`)
      expect(await add("import { type A } from './x'", { module: './x', named: ['A'] })).toBe(`import { A } from './x'\n${tail}`)
      expect(await add("import type D from './x'", { module: './x', defaultImport: 'D' })).toBe(`import D from './x'\n${tail}`)
      expect(await add("import type * as ns from './x'", { module: './x', namespaceImport: 'ns' })).toBe(`import * as ns from './x'\n${tail}`)
      // 升级与合并落在同一条 clause 里也互不干扰。
      expect(await add("import { type A, b } from './x'", { module: './x', named: ['A', 'c'] })).toBe(`import { A, b, c } from './x'\n${tail}`)
      // type-only 语句不能吸收值绑定：升级它，缺失的值绑定另起一条。
      expect(await add("import type { A } from './x'", { module: './x', named: ['A', 'b'] })).toBe(
        `import { A } from './x'\nimport { b } from './x'\n${tail}`
      )
    })

    test('an existing value binding wins over a duplicate type-only one', async () => {
      await withProject(variant.plugins, { 'a.ts': "import type D from './x'\nimport D from './x'\nexport const v = D\n" }, async (project) => {
        const transaction = await project.prepareEdit({
          operations: [{ operation: { type: 'add_import', path: 'a.ts', module: './x', defaultImport: 'D' } }],
        })
        expect(transaction.patches[0]?.metadata).toMatchObject({ noop: true })
      })
    })

    test('a requested type-only binding is satisfied by type-only and value bindings alike', async () => {
      for (const head of ["import type { A } from './x'", "import { type A } from './x'", "import { A } from './x'"]) {
        await withProject(variant.plugins, { 'a.ts': `${head}\nexport const v = 1\n` }, async (project) => {
          const transaction = await project.prepareEdit({
            operations: [{ operation: { type: 'add_import', path: 'a.ts', module: './x', named: ['type A'] } }],
          })
          expect(transaction.patches[0]?.metadata).toMatchObject({ noop: true })
        })
      }
    })

    test('removing an import also removes the next-line directive comments bound to it', async () => {
      expect(await mutate("// @ts-ignore untyped module\nimport legacy from 'legacy'\nconst n: number = 'oops'\n", {
        type: 'remove_import', path: 'a.ts', module: 'legacy',
      })).toBe("const n: number = 'oops'\n")
      expect(await mutate("import { a } from './a'\n// 为什么需要它\n// eslint-disable-next-line import/no-unresolved\n/* @ts-expect-error */\nimport b from 'b'\nexport const x = a\n", {
        type: 'remove_import', path: 'a.ts', module: 'b',
      })).toBe("import { a } from './a'\n// 为什么需要它\nexport const x = a\n")
      // 隔着空行的指令不属于这条 import，保持原样。
      expect(await mutate("// @ts-ignore\n\nimport b from 'b'\nexport const x = 1\n", {
        type: 'remove_import', path: 'a.ts', module: 'b',
      })).toBe('// @ts-ignore\n\nexport const x = 1\n')
    })

    test('the first import goes after file pragmas and detached header comments, never above them', async () => {
      const add = (content: string) => mutate(content, { type: 'add_import', path: 'a.ts', module: './x', named: ['a'] })
      expect(await add('/// <reference types="node" />\nexport const y = 1\n')).toBe(
        '/// <reference types="node" />\nimport { a } from "./x";\nexport const y = 1\n'
      )
      expect(await add('#!/usr/bin/env node\n/// <reference types="node" />\n// @ts-nocheck\n/** 文档 */\nexport const y = 1\n')).toBe(
        '#!/usr/bin/env node\n/// <reference types="node" />\n// @ts-nocheck\nimport { a } from "./x";\n/** 文档 */\nexport const y = 1\n'
      )
      expect(await add('/* License: MIT */\n\n/** 文档 */\nexport const y = 1\n')).toBe(
        '/* License: MIT */\nimport { a } from "./x";\n\n/** 文档 */\nexport const y = 1\n'
      )
      expect(await add('/** 文档 */\nexport const y = 1\n')).toBe('import { a } from "./x";\n/** 文档 */\nexport const y = 1\n')
    })

    test('rejects an importStatement that is not a single import declaration', async () => {
      await withProject(variant.plugins, { 'a.ts': 'export const x = 1\n' }, async (project) => {
        await expect(project.prepareEdit({
          operations: [{ operation: { type: 'add_import', path: 'a.ts', importStatement: 'const x = require("x")' } }],
        })).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
      })
    })
  })
}

describe('JS/TS syntax diagnostics', () => {
  test('every diagnostic carries path, 1-based position, TS code, and a bounded excerpt', async () => {
    const broken = `export function ok() {\n  return 1\n}\nexport const bad = { a: 1,, }\nexport const long = "${'x'.repeat(400)}" +\n`
    for (const variant of KernelVariants) {
      await withProject(variant.plugins, { 'a.ts': broken }, async (project) => {
        const validation = await project.validate({ paths: ['a.ts'] })
        expect(validation.ok).toBe(false)
        expect(validation.diagnostics.length).toBeGreaterThan(0)
        for (const diagnostic of validation.diagnostics.filter((entry) => entry.message.startsWith('JS/TS 语法错误'))) {
          expect(diagnostic.path).toBe('a.ts')
          expect(Number.isInteger(diagnostic.line) && Number(diagnostic.line) >= 1).toBe(true)
          expect(Number.isInteger(diagnostic.column) && Number(diagnostic.column) >= 1).toBe(true)
          expect(Number.isInteger(diagnostic.data?.code)).toBe(true)
          // 摘录上限 160 字符，超长行两端各可能多一个省略号。
          expect(String(diagnostic.data?.excerpt).length).toBeLessThanOrEqual(162)
        }
        const long = validation.diagnostics.find((entry) => entry.line === 5)
        expect(String(long?.data?.excerpt).startsWith('…')).toBe(true)
        const first = validation.diagnostics.find((entry) => entry.line === 4)
        expect(first).toMatchObject({ line: 4, column: 27, data: { code: 1136, excerpt: 'export const bad = { a: 1,, }' } })
        expect(first?.message).toContain('a.ts:4:27')
      })
    }
  })
})
