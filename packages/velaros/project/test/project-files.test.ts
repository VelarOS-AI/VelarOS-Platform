/**
 * `velaros:project` 的读的一侧：read 的源码窗口（连续的正文加第一行的行号）、list、search 窗口，以及三者都不折叠、只有守内存的上限。
 * 一律经 `call('project', …)` 走真的代码面端口；窗口里的正文照磁盘上的原文核对，要改就按路径改。
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ProjectFileLimits, ProjectPolicyDefaults } from '../contract/constants'
import { projectSourceLines } from '../utils/agent/source-window'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-files-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type Fixture = Awaited<ReturnType<typeof projectToolFixture>>

/** 模型面上的一个窗口。 */
interface Window {
  path: string
  revision?: string
  startLine: number
  text: string
  totalLines?: number
  note?: string
}

/** 读一个文件，交回它的第一个窗口。 */
async function readOne(call: Fixture['call'], path: string, range?: unknown) {
  return (
    await call('project', 'read', { files: [range === undefined ? { path } : { path, range }] })
  ).files[0]
}

/** 按路径把一段原文换成新文。 */
function replace(call: Fixture['call'], path: string, oldText: string, newText: string) {
  return call('project', 'edit', { steps: [{ action: 'replace', path, oldText, newText }] })
}

/** 按路径整份写入。 */
function write(call: Fixture['call'], path: string, text: string) {
  return call('project', 'edit', { steps: [{ action: 'write', path, text }] })
}

describe('read 的窗口', () => {
  test('按 range 只交回那几行，窗口里只有模型面的字段；改的时候按整个文件找原文，没读到的行也改得了', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call } = await projectToolFixture({ root })
    const window = await readOne(call, 'a.txt', [2])
    expect(window).toMatchObject({ path: 'a.txt', startLine: 2, text: 'second', totalLines: 3 })
    // 窗口里只有模型面的字段：没有整份正文、内部的源码快照引用，也没有编辑凭据。
    expect(Object.keys(window).sort()).toEqual([
      'path',
      'revision',
      'startLine',
      'text',
      'totalLines',
    ])
    await replace(call, 'a.txt', 'third', 'THIRD')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nsecond\nTHIRD\n')
  })

  test('range 的三种写法读到同一行；CRLF、转义、emoji 原样，整份读回来原样写回一个字节都不变', async () => {
    // 这段正文不是合法的 TS：用 .txt，写回时不跑语法校验。
    const original = 'first\r\n123|literal🙂\\n\r\nlast\r\n'
    await writeFile(join(root, 'a.txt'), original)
    const { call } = await projectToolFixture({ root })
    for (const range of [2, [2], [2, 2]]) {
      expect(await readOne(call, 'a.txt', range), JSON.stringify(range)).toMatchObject({
        startLine: 2,
        text: '123|literal🙂\\n',
        totalLines: 3,
      })
    }
    // 行与行之间是 \n，CRLF 的 \r 不在正文里；写回时按文件原来的换行落盘。
    const whole = await readOne(call, 'a.txt')
    expect(whole.text).toBe('first\n123|literal🙂\\n\nlast\n')
    expect((await write(call, 'a.txt', whole.text)).changed).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(original)
    // 照窗口里的原文写 oldText：换掉的那段两边的 CRLF 原样留着。
    await replace(call, 'a.txt', '123|literal🙂\\n', '456|literal🙂\\n')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(
      'first\r\n456|literal🙂\\n\r\nlast\r\n'
    )
  })

  test('不给 range 就交回整个文件：一千行都在，最后一行照样改得了', async () => {
    const original = Array.from({ length: 1000 }, (_, index) => `line ${index + 1} 🙂`).join('\n')
    await writeFile(join(root, 'a.txt'), original)
    const { call } = await projectToolFixture({ root })
    const window = await readOne(call, 'a.txt')
    expect(window).toMatchObject({ startLine: 1, text: original, totalLines: 1000 })
    expect(window.text.split('\n').at(-1)).toBe('line 1000 🙂')
    // 模型面上没有续读、分段、逐行这些字段了。
    for (const field of ['hasMore', 'continuation', 'fragments', 'lines', 'fileRef'])
      expect(window[field], field).toBeUndefined()
    await replace(call, 'a.txt', 'line 1000 🙂', 'last')
    expect((await readFile(join(root, 'a.txt'), 'utf8')).endsWith('line 999 🙂\nlast')).toBe(true)
  })

  test('一行再长也整行交回', async () => {
    const original = '🙂\\n"'.repeat(100_000)
    await writeFile(join(root, 'a.ts'), original)
    const { call } = await projectToolFixture({ root })
    expect(await readOne(call, 'a.ts')).toMatchObject({
      startLine: 1,
      text: original,
      totalLines: 1,
    })
  })

  test('读到文件外时给空窗口并说明', async () => {
    await writeFile(join(root, 'target.ts'), 'const a = 1\nconst b = 2\n')
    const { call } = await projectToolFixture({ root })
    const beyond = await readOne(call, 'target.ts', [99, 100])
    // 行数照 wc -l 数，说明也照它写。
    expect(beyond).toMatchObject({ text: '', totalLines: 2 })
    expect(beyond.note).toContain('文件共 2 行')
    expect(beyond.note).toContain('超出范围')
    // 从最后一行的下一行起读：那里只有结尾换行之后那个零宽的行，正文是空的，不算超出范围。
    const tail = await readOne(call, 'target.ts', [3, 5])
    expect(tail).toMatchObject({ startLine: 3, text: '', totalLines: 2 })
    expect(tail.note).toBeUndefined()
  })

  test('读到的总是现在的正文，改的时候按提交时的正文算：版本号只看元数据、正文变了版本号没变也一样；换了会话照样改', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    await utimes(join(root, 'a.ts'), 10, 10)
    const { call, context } = await projectToolFixture({
      root,
      corePolicy: { revisionStrategy: 'metadata' },
    })
    const before = await readOne(call, 'a.ts')
    // 同样大小、同样 mtime 的外部改动：版本号不变，正文变了。
    await writeFile(join(root, 'a.ts'), 'other')
    await utimes(join(root, 'a.ts'), 10, 10)
    const after = await readOne(call, 'a.ts')
    expect(after.revision).toBe(before.revision)
    expect(after.text).toBe('other')
    // 按路径改不凭本会话读过什么。
    context.sessionId = 'another-session'
    const stale = await failureOf(replace(call, 'a.ts', 'first', 'x'))
    expect(stale.code).toBe('TARGET_NOT_FOUND')
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('other')
    await replace(call, 'a.ts', 'other', 'x')
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('x')
  })

  test('行数照 wc -l 数：结尾的换行不算多出一行；读到文件末尾时正文带着结尾的换行，整份读回来原样写回不多一行也不少一行', async () => {
    const { call } = await projectToolFixture({ root })
    for (const [original, totalLines] of [
      ['', 0],
      ['line\n', 1],
      ['a\n\n', 2],
      ['a\nb', 2],
    ] as const) {
      await writeFile(join(root, 'a.ts'), original)
      const window = await readOne(call, 'a.ts')
      expect(window, JSON.stringify(original)).toMatchObject({
        startLine: 1,
        text: original,
        totalLines,
      })
      expect((await write(call, 'a.ts', window.text)).changed, JSON.stringify(original)).toBe(false)
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(original)
    }
    // 按范围读到最后一行真实的行，就算读到头了：正文带着结尾的换行，没有续读；接着写一行就正好多一行。
    await writeFile(join(root, 'a.ts'), 'a\n\n')
    const ranged = await readOne(call, 'a.ts', [1, 2])
    expect(ranged).toMatchObject({ startLine: 1, text: 'a\n\n', totalLines: 2 })
    expect(ranged.hasMore).toBeUndefined()
    await write(call, 'a.ts', `${ranged.text}z\n`)
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('a\n\nz\n')
    // 只有 \n 与 \r\n 算换行，孤立的 \r 是行里的字符。
    expect(projectSourceLines('a\r\nb\rc').map((line) => line.text)).toEqual(['a', 'b\rc'])
  })

  test('同一个文件读两段：各是一个窗口，各带自己的起始行号；同一个文件可以接连几步改', async () => {
    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\nfive')
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'read', {
      files: [
        { path: 'a.ts', range: 1 },
        { path: 'a.ts', range: [4, 5] },
      ],
    })
    expect(
      result.files.map((window: Window) => [window.path, window.startLine, window.text])
    ).toEqual([
      ['a.ts', 1, 'one'],
      ['a.ts', 4, 'four\nfive'],
    ])
    await call('project', 'edit', {
      steps: [
        { action: 'replace', path: 'a.ts', oldText: 'one', newText: 'ONE' },
        { action: 'replace', path: 'a.ts', oldText: 'five', newText: 'FIVE' },
      ],
    })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE')
  })

  test('路径钳在项目里：项目里的绝对路径也认，出了项目就拒', async () => {
    await writeFile(join(root, 'a.txt'), 'inside\n')
    const { call } = await projectToolFixture({ root })
    expect(await readOne(call, join(root, 'a.txt'))).toMatchObject({
      path: 'a.txt',
      text: 'inside\n',
    })
    const outside = await failureOf(readOne(call, '../outside.txt'))
    expect(outside.code).toBe('PERMISSION_DENIED')
    expect(outside.message).toContain('项目之内')
  })

  test('像密钥的片段原样读出来，照常能改', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    const original = `const token = "${secret}"\nconst plain = 1\n`
    await writeFile(join(root, 'env.ts'), original)
    const { call } = await projectToolFixture({ root })
    const window = await readOne(call, 'env.ts')
    expect(window.text).toBe(original)
    expect(window.note).toBeUndefined()
    await replace(call, 'env.ts', 'const plain = 1', 'const plain = 2')
    expect(await readFile(join(root, 'env.ts'), 'utf8')).toBe(
      original.replace('plain = 1', 'plain = 2')
    )
  })

  test('超过可编辑上限的大文件照样读得到、带一句说明；write、replace 改不了它，直说', async () => {
    const line = `${'a'.repeat(127)}\n`
    const lines = Math.ceil(
      (ProjectPolicyDefaults.maxFileSizeToReadBytes + 1024 * 1024) / line.length
    )
    await writeFile(join(root, 'huge.txt'), line.repeat(lines))
    await writeFile(join(root, 'small.txt'), 'first\nsecond\nthird\n')
    const { call } = await projectToolFixture({ root })
    const huge = await readOne(call, 'huge.txt', [1, 2])
    expect(huge).toMatchObject({ startLine: 1, text: `${'a'.repeat(127)}\n${'a'.repeat(127)}` })
    expect(huge.note).toContain('可编辑的上限')
    for (const step of [
      { action: 'replace', path: 'huge.txt', oldText: 'a'.repeat(127), newText: 'b' },
      { action: 'write', path: 'huge.txt', text: 'b\n' },
    ]) {
      const failure = await failureOf(call('project', 'edit', { steps: [step] }))
      expect(failure.code, step.action).toBe('NOT_SUPPORTED')
      expect(failure.message, step.action).toContain('可编辑的上限')
    }
    expect((await stat(join(root, 'huge.txt'))).size).toBe(line.length * lines)
    // 同一条路上的普通文件照常读、照常改。
    const small = await readOne(call, 'small.txt', [1, 2])
    expect(small.note).toBeUndefined()
    await replace(call, 'small.txt', 'second', 'SECOND')
    expect(await readFile(join(root, 'small.txt'), 'utf8')).toBe('first\nSECOND\nthird\n')
  }, 120_000)
})

describe('批量读', () => {
  test('每个文件的 range 各管各的，读不到的只进 issues，不吞掉别的窗口', async () => {
    await writeFile(join(root, 'a.ts'), 'a1\na2\na3')
    await writeFile(join(root, 'b.ts'), 'b1\nb2\nb3')
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'read', {
      files: [{ path: 'a.ts', range: 2 }, { path: 'missing.ts' }, { path: 'b.ts', range: [1, 2] }],
    })
    expect(
      result.files.map((window: Window) => [window.path, window.startLine, window.text])
    ).toEqual([
      ['a.ts', 2, 'a2'],
      ['b.ts', 1, 'b1\nb2'],
    ])
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: 'missing.ts',
        code: 'TARGET_NOT_FOUND',
        next: expect.stringContaining('list'),
      }),
    ])
    // 只读一个文件时读不到就整个调用失败。
    const single = await failureOf(readOne(call, 'missing.ts'))
    expect(single.code).toBe('TARGET_NOT_FOUND')
    expect(single.message).toContain('list')
  })

  test('读不到的文件进 issues（出了项目、不存在），其余文件照常给窗口', async () => {
    await writeFile(join(root, 'open.txt'), 'visible\n')
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'read', {
      files: [{ path: '../outside.txt' }, { path: 'missing.txt' }, { path: 'open.txt', range: 1 }],
    })
    // 第 1 行就是最后一行：读到了文件末尾，正文带着结尾的换行。
    expect(result.files).toEqual([
      expect.objectContaining({ path: 'open.txt', startLine: 1, text: 'visible\n' }),
    ])
    expect(result.issues).toEqual([
      expect.objectContaining({ path: '../outside.txt', code: 'PERMISSION_DENIED' }),
      expect.objectContaining({ path: 'missing.txt', code: 'TARGET_NOT_FOUND' }),
    ])
  })

  test('批量读每个文件都整份交回', async () => {
    const modules = Array.from({ length: 6 }, (_, index) => {
      const lines = Array.from(
        { length: 120 },
        (_, line) => `export const value_${index}_${line} = "中文🙂 ${'x'.repeat(28)}" // beacon`
      )
      return { path: `module-${index}.ts`, text: `${lines.join('\n')}\n` }
    })
    for (const { path, text } of modules) await writeFile(join(root, path), text)
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'read', { files: modules.map(({ path }) => ({ path })) })
    expect(result.issues).toBeUndefined()
    expect(result.files).toEqual(
      modules.map(({ path, text }) =>
        expect.objectContaining({ path, startLine: 1, text, totalLines: 120 })
      )
    )
  })

  test('一次 read 交回的正文有守内存的上限：批量里装不下的文件进 issues，只读一个时整个失败，都说清怎么分段', async () => {
    await writeFile(join(root, 'a.txt'), `${'a'.repeat(99)}\n`)
    await writeFile(join(root, 'big.txt'), 'b\n')
    const { call, kernel } = await projectToolFixture({ root })
    // 真去读两千万字符太重：big.txt 装作比剩下的量还大，内核在 maxChars 装不下时就是这样回的。
    const budgets: Array<[string, Optional<number>]> = []
    const read = kernel.read.bind(kernel)
    kernel.read = async (input) => {
      budgets.push([input.path, input.maxChars])
      const value = await read(input)
      return input.path === 'big.txt'
        ? { ...value, content: '', truncated: true, hasMore: true }
        : value
    }
    const result = await call('project', 'read', {
      files: [{ path: 'a.txt' }, { path: 'big.txt' }],
    })
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(['a.txt'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: 'big.txt',
        code: 'SCOPE_VIOLATION',
        next: '单独读它，或者用 range 分几段读。',
      }),
    ])
    // 上限是整次调用共用的：a.txt 交回了多少，big.txt 能用的就少多少。
    expect(budgets.filter(([path]) => path === 'a.txt')[0]).toEqual([
      'a.txt',
      ProjectFileLimits.readChars,
    ])
    expect(budgets.filter(([path]) => path === 'big.txt')[0]).toEqual([
      'big.txt',
      ProjectFileLimits.readChars - 100,
    ])
    const single = await failureOf(readOne(call, 'big.txt'))
    expect(single.code).toBe('SCOPE_VIOLATION')
    expect(single.message).toContain(String(ProjectFileLimits.readChars))
    expect(single.message).toContain('用 range 分几段读')
  })

  test('入参自己核对：files 要 1–20 项，range 的末行不小于首行', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await projectToolFixture({ root })
    for (const input of [
      { path: 'a.txt' },
      { files: [] },
      { files: Array.from({ length: ProjectFileLimits.readFiles + 1 }, () => ({ path: 'a.txt' })) },
      { files: [{ path: 'a.txt', range: [3, 1] }] },
      { files: [{ path: '' }] },
    ])
      expect((await failureOf(call('project', 'read', input))).code, JSON.stringify(input)).toBe(
        'INVALID_INPUT'
      )
  })
})

describe('list', () => {
  test('交回全部条目，按深度优先的稳定顺序：不给 depth 是整棵树，depth 1 只列当前目录', async () => {
    await mkdir(join(root, 'src/deep/deeper/deepest'), { recursive: true })
    await writeFile(join(root, 'src/top.ts'), 'export {}\n')
    await writeFile(join(root, 'src/deep/deeper/deepest/leaf.ts'), 'export {}\n')
    const { call } = await projectToolFixture({ root })
    const listed = async (input: Record<string, unknown>) => call('project', 'list', input)
    const paths = async (input: Record<string, unknown>) =>
      (await listed(input)).entries.map((entry: { path: string }) => entry.path)
    expect(await paths({ path: 'src' })).toEqual([
      'src/deep',
      'src/deep/deeper',
      'src/deep/deeper/deepest',
      'src/deep/deeper/deepest/leaf.ts',
      'src/top.ts',
    ])
    expect(await paths({ path: 'src', depth: 1 })).toEqual(['src/deep', 'src/top.ts'])
    expect(await paths({ path: 'src', depth: 2 })).toEqual([
      'src/deep',
      'src/deep/deeper',
      'src/top.ts',
    ])
    // 回执里只有条目：没有分页、没有截断标记。
    expect(Object.keys(await listed({ path: 'src' }))).toEqual(['entries'])
    // 不合法的层数当场拒绝；'all' 不再是一个值，不给 depth 就是整棵树。
    for (const depth of [0, ProjectFileLimits.listDepth + 1, 'all']) {
      expect((await failureOf(listed({ path: 'src', depth }))).code, String(depth)).toBe(
        'INVALID_INPUT'
      )
    }
  })

  test('条目超过守内存的上限时整个失败，不交回一部分冒充全部', async () => {
    const { call, kernel } = await projectToolFixture({ root })
    const requested: Array<Optional<number>> = []
    kernel.listFiles = async (input) => {
      requested.push(input?.maxFiles)
      return Array.from({ length: input?.maxFiles ?? 0 }, (_, index) => ({
        path: `f${index}.ts`,
        type: 'file' as const,
      }))
    }
    const failure = await failureOf(call('project', 'list', {}))
    expect(failure.code).toBe('SCOPE_VIOLATION')
    expect(failure.message).toContain(String(ProjectFileLimits.listEntries))
    expect(failure.message).toContain('收窄 path、include 或 depth')
    // 多要一条，拿到了就知道超了。
    expect(requested).toEqual([ProjectFileLimits.listEntries + 1])
  })
  test('glob 照 rg -g 的习惯：不带 / 的按文件名、任意深度都算，带 / 的从 path 起算；搜索的 glob 同样相对 path', async () => {
    await mkdir(join(root, 'src/lib'), { recursive: true })
    await writeFile(join(root, 'top.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'src/price.ts'), 'export const price = 1\n')
    await writeFile(join(root, 'src/lib/cart.ts'), 'export const price = 2\n')
    await writeFile(join(root, 'src/lib/cart.test.ts'), 'export const price = 3\n')
    await writeFile(join(root, 'src/notes.md'), 'price\n')
    const { call } = await projectToolFixture({ root })
    const listed = async (input: Record<string, unknown>) =>
      (await call('project', 'list', input)).entries
        .filter((entry: { type: string }) => entry.type === 'file')
        .map((entry: { path: string }) => entry.path)
        .sort()
    expect(await listed({ include: ['*.ts'] })).toEqual([
      'src/lib/cart.test.ts',
      'src/lib/cart.ts',
      'src/price.ts',
      'top.ts',
    ])
    expect(await listed({ path: 'src', include: ['*.ts'], exclude: ['*.test.ts'] })).toEqual([
      'src/lib/cart.ts',
      'src/price.ts',
    ])
    expect(await listed({ path: 'src', include: ['lib/*.ts'] })).toEqual([
      'src/lib/cart.test.ts',
      'src/lib/cart.ts',
    ])
    // 已经写成从项目根起的也认。
    expect(await listed({ path: 'src', include: ['src/lib/*.ts'] })).toEqual([
      'src/lib/cart.test.ts',
      'src/lib/cart.ts',
    ])

    const hits = async (input: Record<string, unknown>) =>
      (await call('project', 'search', { query: 'price', contextLines: 0, ...input })).hits
        .map((hit: { path: string }) => hit.path)
        .sort()
    expect(await hits({ include: ['*.ts'] })).toEqual([
      'src/lib/cart.test.ts',
      'src/lib/cart.ts',
      'src/price.ts',
    ])
    expect(await hits({ path: 'src/lib', include: ['*.ts'], exclude: ['*.test.ts'] })).toEqual([
      'src/lib/cart.ts',
    ])
  })

  test('列一个不存在的目录、或者把文件当目录列，直说，不装成空目录', async () => {
    await writeFile(join(root, 'a.ts'), 'export {}\n')
    const { call } = await projectToolFixture({ root })
    expect((await failureOf(call('project', 'list', { path: 'nope' }))).code).toBe(
      'TARGET_NOT_FOUND'
    )
    expect((await failureOf(call('project', 'list', { path: 'a.ts' }))).code).toBe('INVALID_INPUT')
  })
})

describe('search', () => {
  test('字面与正则都搜得到；命中处的窗口是连续的原文，照着写 oldText 就能改', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nneedle A\nsecond\nneedle B\nend\n')
    const { call } = await projectToolFixture({ root })
    const literal = await call('project', 'search', {
      query: 'needle A',
      regex: false,
      contextLines: 0,
    })
    expect(literal.hits).toHaveLength(1)
    expect(literal.files).toEqual([
      expect.objectContaining({ path: 'a.txt', startLine: 2, text: 'needle A' }),
    ])
    await replace(call, 'a.txt', literal.files[0].text, 'changed A')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(
      'first\nchanged A\nsecond\nneedle B\nend\n'
    )
    const regex = await call('project', 'search', {
      query: '(changed|needle) [AB]',
      regex: true,
      caseSensitive: true,
      contextLines: 0,
    })
    expect(regex.hits).toHaveLength(2)
    // 同一个文件里不相连的两处各是一个窗口。
    expect(
      regex.files.map((window: Window) => [window.path, window.startLine, window.text])
    ).toEqual([
      ['a.txt', 2, 'changed A'],
      ['a.txt', 4, 'needle B'],
    ])
  })

  test('窗口是命中所在的那一版；搜完之后文件又被改了，命中照样给位置和 snippet，只是没有窗口', async () => {
    await writeFile(join(root, 'a.ts'), 'before\nconst target = 1\nafter\n')
    const { call, kernel } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'target' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].revision).toBeTruthy()
    // 命中进了窗口就不另给 snippet；窗口读到了最后一行，正文带着结尾的换行。
    expect(result.hits[0].snippet).toBeUndefined()
    expect(result.files).toEqual([
      expect.objectContaining({
        revision: result.hits[0].revision,
        startLine: 1,
        text: 'before\nconst target = 1\nafter\n',
      }),
    ])
    const search = kernel.search.bind(kernel)
    kernel.search = async (input) => {
      const found = await search(input)
      await writeFile(join(root, 'a.ts'), 'before\nconst target = 2\nafter\n')
      return found
    }
    const changed = await call('project', 'search', { query: 'target' })
    expect(changed.files).toEqual([])
    expect(changed.hits[0].range.startLine).toBe(2)
    expect(changed.hits[0].snippet).toContain('const target = 1')
  })

  test('交回全部命中：一百个文件一百个窗口', async () => {
    for (let index = 0; index < 100; index++)
      await writeFile(
        join(root, `hit-${index}.ts`),
        `// before\nexport const needle_${index} = ${index}\n// after\n`
      )
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'needle', contextLines: 3 })
    expect(result.hits).toHaveLength(100)
    expect(result.truncated).toBeUndefined()
    expect(result.files).toHaveLength(100)
    expect(new Set(result.files.map((window: Window) => window.path)).size).toBe(100)
    for (const hit of result.hits) expect(hit.snippet, hit.path).toBeUndefined()
    for (const window of result.files as Window[]) {
      const index = Number(/^hit-(\d+)\.ts$/.exec(window.path)?.[1])
      expect(window.text, window.path).toBe(
        `// before\nexport const needle_${index} = ${index}\n// after\n`
      )
    }
  })

  test('一个文件里相隔很远的几处命中各是一个窗口：只有命中附近的行', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    lines[1] = 'needle one'
    lines[19] = 'needle two'
    await writeFile(join(root, 'a.txt'), `${lines.join('\n')}\n`)
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'needle' })
    expect(result.hits.map((hit: { range: { startLine: number } }) => hit.range.startLine)).toEqual(
      [2, 20]
    )
    expect(
      result.files.map((window: Window) => [
        window.path,
        window.startLine,
        window.text,
        window.totalLines,
      ])
    ).toEqual([
      ['a.txt', 1, 'line 1\nneedle one\nline 3', 30],
      ['a.txt', 19, 'line 19\nneedle two\nline 21', 30],
    ])
  })

  test('命中超过守内存的上限、或者搜索没能收全（超时）时整个失败，不交回一部分冒充全部', async () => {
    const { call, kernel } = await projectToolFixture({ root })
    const requested: Array<Optional<number>> = []
    const hit = (index: number) => ({
      path: `f${index}.ts`,
      revision: 'r',
      score: 1,
      kind: 'text' as const,
      range: { startLine: 1, endLine: 1 },
    })
    kernel.search = async (input) => {
      requested.push(input.maxResults)
      return {
        query: input.query,
        hits: Array.from({ length: input.maxResults ?? 0 }, (_, index) => hit(index)),
        truncated: true,
      }
    }
    const tooMany = await failureOf(call('project', 'search', { query: 'x' }))
    expect(tooMany.code).toBe('SCOPE_VIOLATION')
    expect(tooMany.message).toContain(String(ProjectFileLimits.searchHits))
    expect(tooMany.message).toContain('收窄 query、path 或 include')
    expect(requested).toEqual([ProjectFileLimits.searchHits + 1])
    kernel.search = async (input) => ({
      query: input.query,
      hits: [hit(0)],
      truncated: true,
      diagnostics: ['ripgrep 搜索超过 120000 毫秒超时'],
    })
    const timedOut = await failureOf(call('project', 'search', { query: 'x' }))
    expect(timedOut.code).toBe('SCOPE_VIOLATION')
    expect(timedOut.message).toContain('超时')
  })

  test('内核的搜索不按文件截命中：一个文件上千处命中照样全部交回', async () => {
    const content = `${Array.from({ length: 1200 }, (_, index) => `hit ${index}`).join('\n')}\n`
    await writeFile(join(root, 'many.ts'), content)
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'hit', contextLines: 0 })
    expect(result.hits).toHaveLength(1200)
    // 命中一行挨一行，并成一个窗口：就是整个文件。
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ startLine: 1, text: content, totalLines: 1200 })
  })
})
