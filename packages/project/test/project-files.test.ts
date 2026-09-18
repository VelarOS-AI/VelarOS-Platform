/**
 * `velar:project` 的读的一侧：read 的源码窗口与 fileRef 覆盖、续读、list 分页、search 窗口。
 * 一律经 `call('project', …)` 走真的代码面端口；fileRef 实际覆盖了什么用 `loadFileView` 核对。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ProjectPolicyDefaults } from '../src/contract/constants'
import { createSecretRedactionProvider } from '../src/index'
import { loadFileView } from '../src/utils/agent/file-refs'
import { projectSourceLines } from '../src/utils/agent/source-window'

import { failureOf, projectSpaceFixture } from './support/space'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-files-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

type Fixture = Awaited<ReturnType<typeof projectSpaceFixture>>

/** 读一个文件，交回它的第一个窗口。 */
async function readOne(call: Fixture['call'], path: string, range?: unknown, maxChars?: number) {
  const item = range === undefined ? { path } : { path, range }
  const input = maxChars === undefined ? { files: [item] } : { files: [item], maxChars }
  return (await call('project', 'read', input)).files[0]
}

/** 凭一个 fileRef 改一处。 */
function editLine(call: Fixture['call'], fileRef: string, range: unknown, text: string) {
  return call('project', 'edit', { steps: [{ action: 'edit', fileRef, edits: [{ op: 'replace', range, text }] }] })
}

describe('read 的窗口与 fileRef', () => {
  test('fileRef 只授权真正交出去的那几行：窗口外的一行都改不了', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call, context } = await projectSpaceFixture({ root })
    const window = await readOne(call, 'a.txt', [2])
    expect(window.lines).toEqual([[2, 'second']])
    expect(window.fileRef).toStartWith('view:')
    // 窗口里只有模型面的字段：没有整份正文，也没有内部的源码快照引用。
    expect(window.content).toBeUndefined()
    expect(window.viewSource).toBeUndefined()
    const view = await loadFileView(context, window.fileRef)
    expect(view.content).toBe('first\nsecond\nthird\n')
    expect(view.coverage).toEqual([{ startOffset: 6, endOffset: 13, startLine: 2, endLine: 2, completeLines: true }])
    const failure = await failureOf(editLine(call, window.fileRef, 3, 'bad'))
    expect(failure.code).toBe('SCOPE_VIOLATION')
    expect(failure.message).toContain('steps[0].edits[0]')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nsecond\nthird\n')
  })

  test('range 的三种写法、原样的行文本与整份原文共用一套坐标（CRLF、转义、emoji）', async () => {
    const original = 'first\r\n123|literal🙂\\n\r\nlast\r\n'
    await writeFile(join(root, 'a.ts'), original)
    const { call, context } = await projectSpaceFixture({ root })
    for (const range of [2, [2], [2, 2]]) {
      const window = await readOne(call, 'a.ts', range)
      expect(window.lines).toEqual([[2, '123|literal🙂\\n']])
      const view = await loadFileView(context, window.fileRef)
      expect(view.content).toBe(original)
      expect(view.coverage).toEqual([{ startOffset: 7, endOffset: original.indexOf('last'), startLine: 2, endLine: 2, completeLines: true }])
    }
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(original)
  })

  test('maxChars 只装整行：fileRef 覆盖到最后一整行为止，后面的行要续读才改得了', async () => {
    await writeFile(join(root, 'a.ts'), Array.from({ length: 1000 }, (_, index) => `line ${index + 1} 🙂`).join('\n'))
    const { call, context } = await projectSpaceFixture({ root })
    const window = await readOne(call, 'a.ts', undefined, 1800)
    expect(window.lines.length).toBeGreaterThan(0)
    expect(window.lines.length).toBeLessThan(1000)
    expect(window.hasMore).toBe(true)
    expect(window.continuation).toStartWith('read-page:')
    const last = window.lines.at(-1)[0]
    const view = await loadFileView(context, window.fileRef)
    expect(view.coverage).toHaveLength(1)
    expect(view.coverage[0]!.endLine).toBe(last)
    expect((await failureOf(editLine(call, window.fileRef, last + 1, 'x'))).code).toBe('SCOPE_VIOLATION')
    // 续读引用不是编辑凭据。
    const misused = await failureOf(editLine(call, window.continuation, 1, 'x'))
    expect(misused.code).toBe('INVALID_INPUT')
    expect(misused.message).toContain('不是可编辑的 fileRef')
    const next = (await call('project', 'read', { continuation: window.continuation, maxChars: 1800 })).files[0]
    expect(next.lines[0]).toEqual([last + 1, `line ${last + 1} 🙂`])
  })

  test('一行太长时只授权交出去的那几个字符，续读从上一截的末尾接着走', async () => {
    const original = '🙂\\n"'.repeat(1000)
    await writeFile(join(root, 'a.ts'), original)
    const { call, context } = await projectSpaceFixture({ root })
    const first = await readOne(call, 'a.ts', undefined, 1200)
    expect(first.lines).toEqual([])
    expect(first.fragments[0].text.isWellFormed()).toBe(true)
    const view = await loadFileView(context, first.fileRef)
    expect(view.coverage[0]!.completeLines).toBe(false)
    expect(view.coverage[0]!.endOffset).toBe(first.fragments[0].columns[1] - 1)
    // 半行的 fileRef 不授权整行编辑。
    expect((await failureOf(editLine(call, first.fileRef, 1, 'x'))).code).toBe('SCOPE_VIOLATION')
    const second = (await call('project', 'read', { continuation: first.continuation, maxChars: 1200 })).files[0]
    expect(second.fragments[0].columns[0]).toBe(first.fragments[0].columns[1])
    expect(original.startsWith(first.fragments[0].text + second.fragments[0].text)).toBe(true)
  })

  test('只读到半行或读到文件外时不给整行的编辑权', async () => {
    await writeFile(join(root, 'target.ts'), 'const a = 1\nconst b = 2\n')
    const { call } = await projectSpaceFixture({ root })
    const partial = await readOne(call, 'target.ts', undefined, 2)
    expect(partial.lines).toEqual([])
    expect(partial.fragments).toEqual([{ line: 1, columns: [1, 3], text: 'co' }])
    expect((await failureOf(editLine(call, partial.fileRef, 1, 'const a = 3'))).code).toBe('SCOPE_VIOLATION')
    const beyond = await readOne(call, 'target.ts', [99, 100])
    expect(beyond).toMatchObject({ lines: [], totalLines: 3, editable: false })
    expect(beyond.fileRef).toBeUndefined()
    expect(beyond.note).toContain('超出范围')
    expect(await readFile(join(root, 'target.ts'), 'utf8')).toBe('const a = 1\nconst b = 2\n')
  })

  test('fileRef 只在签发它的会话里有效；正文变了就作废，哪怕版本号没变', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    const { call, context, kernel } = await projectSpaceFixture({ root })
    // 版本号只看元数据的宿主：内容变了版本号也不变，fileRef 照样要按正文核对。
    const originalRead = kernel.read.bind(kernel)
    kernel.read = async (input) => {
      const value = await originalRead({ ...input, baseRevision: undefined })
      return { ...value, snapshot: { ...value.snapshot, revision: 'constant-metadata-revision' } }
    }
    const window = await readOne(call, 'a.ts')
    const own = context.sessionId
    context.sessionId = 'another-session'
    const foreign = await failureOf(editLine(call, window.fileRef, 1, 'x'))
    expect(foreign.code).toBe('INVALID_INPUT')
    expect(foreign.message).toContain('不是本会话签发的')
    context.sessionId = own
    await writeFile(join(root, 'a.ts'), 'other')
    expect((await failureOf(editLine(call, window.fileRef, 1, 'x'))).code).toBe('BASE_REVISION_MISMATCH')
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('other')
    const next = await readOne(call, 'a.ts')
    expect(next.fileRef).not.toBe(window.fileRef)
    expect((await loadFileView(context, next.fileRef)).content).toBe('other')
  })

  test('空文件与末尾的空行都有零宽的整行覆盖', async () => {
    const { call, context } = await projectSpaceFixture({ root })
    for (const original of ['', 'line\n']) {
      await writeFile(join(root, 'a.ts'), original)
      const window = await readOne(call, 'a.ts')
      expect(window.lines.at(-1)).toEqual([original ? 2 : 1, ''])
      const view = await loadFileView(context, window.fileRef)
      expect(view.coverage.at(-1)?.completeLines).toBe(true)
      expect(view.coverage.at(-1)?.endOffset).toBe(original.length)
    }
    // 只有 \n 与 \r\n 算换行，孤立的 \r 是行里的字符。
    expect(projectSourceLines('a\r\nb\rc').map((line) => line.text)).toEqual(['a', 'b\rc'])
  })

  test('同一份源码不相连的几个窗口共用一个 fileRef，中间没读的行照样改不了', async () => {
    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\nfive')
    const { call, context } = await projectSpaceFixture({ root })
    const result = await call('project', 'read', { files: [{ path: 'a.ts', range: 1 }, { path: 'a.ts', range: [4, 5] }] })
    expect(result.files.map((window: { lines: unknown }) => window.lines)).toEqual([[[1, 'one']], [[4, 'four'], [5, 'five']]])
    const [{ fileRef }] = result.files
    expect(result.files[1].fileRef).toBe(fileRef)
    const view = await loadFileView(context, fileRef)
    expect(view.coverage.map((range) => [range.startLine, range.endLine])).toEqual([[1, 1], [4, 5]])
    expect((await failureOf(editLine(call, fileRef, 2, 'TWO'))).code).toBe('SCOPE_VIOLATION')
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef, edits: [{ op: 'replace', range: 1, text: 'ONE' }, { op: 'replace', range: 5, text: 'FIVE' }] }] })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE')
  })

  test('续读页记着原来的版本：文件在两页之间改过就作废', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call } = await projectSpaceFixture({ root })
    const first = await readOne(call, 'a.txt', undefined, 6)
    expect(first.lines).toEqual([[1, 'first']])
    expect(first.continuation).toStartWith('read-page:')
    const next = (await call('project', 'read', { continuation: first.continuation, maxChars: 20 })).files[0]
    expect(next.lines[0]).toEqual([2, 'second'])
    await writeFile(join(root, 'a.txt'), 'new\nsecond\nthird\n')
    const stale = await failureOf(call('project', 'read', { continuation: first.continuation }))
    expect(stale.code).toBe('BASE_REVISION_MISMATCH')
    expect(stale.message).toContain('a.txt')
  })

  test('路径钳在项目里：项目里的绝对路径也认，出了项目就拒', async () => {
    await writeFile(join(root, 'a.txt'), 'inside\n')
    const { call } = await projectSpaceFixture({ root })
    expect((await readOne(call, join(root, 'a.txt'))).lines).toEqual([[1, 'inside'], [2, '']])
    const outside = await failureOf(readOne(call, '../outside.txt'))
    expect(outside.code).toBe('PERMISSION_DENIED')
    expect(outside.message).toContain('项目之内')
  })

  test('像密钥的片段读出来是遮住的，这样的窗口只能看、不能改', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    await writeFile(join(root, 'env.ts'), `const token = "${secret}"\nconst plain = 1\n`)
    const { call } = await projectSpaceFixture({ root, providers: { secretRedaction: createSecretRedactionProvider() } })
    const window = await readOne(call, 'env.ts')
    expect(window.lines[0]).toEqual([1, 'const token = "[REDACTED]"'])
    expect(window).toMatchObject({ redacted: true, editable: false })
    expect(window.fileRef).toBeUndefined()
    expect(window.note).toContain('遮住')
    expect(JSON.stringify(window)).not.toContain(secret)
  })

  test('超过可编辑上限的大文件只给只读窗口并说明，不签发用起来必然失败的 fileRef', async () => {
    const line = `${'a'.repeat(127)}\n`
    const lines = Math.ceil((ProjectPolicyDefaults.maxFileSizeToReadBytes + 1024 * 1024) / line.length)
    await writeFile(join(root, 'huge.txt'), line.repeat(lines))
    await writeFile(join(root, 'small.txt'), 'first\nsecond\nthird\n')
    const { call } = await projectSpaceFixture({ root })
    const huge = await readOne(call, 'huge.txt', [1, 2])
    expect(huge.lines[0]).toEqual([1, 'a'.repeat(127)])
    expect(huge.fileRef).toBeUndefined()
    expect(huge.editable).toBe(false)
    expect(huge.note).toContain('可编辑的上限')
    // 同一条路上的普通文件照常签发 fileRef。
    const small = await readOne(call, 'small.txt', [1, 2])
    expect(small.fileRef).toStartWith('view:')
    expect(small.note).toBeUndefined()
  }, 120_000)
})

describe('批量读', () => {
  test('每个文件的 range 各管各的，读不到的只进 issues，不吞掉别的窗口', async () => {
    await writeFile(join(root, 'a.ts'), 'a1\na2\na3')
    await writeFile(join(root, 'b.ts'), 'b1\nb2\nb3')
    const { call } = await projectSpaceFixture({ root })
    const result = await call('project', 'read', { files: [{ path: 'a.ts', range: 2 }, { path: 'missing.ts' }, { path: 'b.ts', range: [1, 2] }] })
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(['a.ts', 'b.ts'])
    expect(result.files[0].lines).toEqual([[2, 'a2']])
    expect(result.files[1].lines).toEqual([[1, 'b1'], [2, 'b2']])
    expect(result.issues).toEqual([expect.objectContaining({ path: 'missing.ts', code: 'TARGET_NOT_FOUND', next: expect.stringContaining('list') })])
    // 只读一个文件时读不到就整个调用失败。
    const single = await failureOf(readOne(call, 'missing.ts'))
    expect(single.code).toBe('TARGET_NOT_FOUND')
    expect(single.message).toContain('list')
  })

  test('不许读的文件进 issues，其余文件照常给可编辑的窗口', async () => {
    await writeFile(join(root, 'open.txt'), 'visible\n')
    await writeFile(join(root, 'denied.txt'), 'private\n')
    const { call } = await projectSpaceFixture({ root, corePolicy: { readDeny: ['denied.txt'] } })
    const result = await call('project', 'read', { files: [{ path: 'denied.txt' }, { path: 'open.txt', range: 1 }] })
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(['open.txt'])
    expect(result.files[0].fileRef).toStartWith('view:')
    expect(result.issues).toEqual([expect.objectContaining({ path: 'denied.txt', code: 'PERMISSION_DENIED' })])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  test('共用的字符预算按请求的顺序给每个文件都留下窗口：看得到开头，没读完的带续读', async () => {
    const modules = Array.from({ length: 6 }, (_, index) => `module-${index}.ts`)
    for (const [index, path] of modules.entries()) {
      const lines = Array.from({ length: 120 }, (_, line) => `export const value_${index}_${line} = "中文🙂 ${'x'.repeat(28)}" // beacon`)
      await writeFile(join(root, path), `${lines.join('\n')}\n`)
    }
    const { call } = await projectSpaceFixture({ root })
    const result = await call('project', 'read', { files: modules.map((path) => ({ path })), maxChars: 60_000 })
    expect(result.issues).toBeUndefined()
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(modules)
    for (const [index, window] of result.files.entries()) {
      expect(window.lines[0], window.path).toEqual([1, `export const value_${index}_0 = "中文🙂 ${'x'.repeat(28)}" // beacon`])
      expect(window.fileRef, window.path).toStartWith('view:')
      if (window.hasMore) expect(window.continuation, window.path).toStartWith('read-page:')
    }
    // 预算是整次调用共用的：六个文件加起来不超过 maxChars。
    const shown = result.files.flatMap((window: { lines: Array<[number, string]> }) => window.lines.map(([, text]) => `${text}\n`)).join('')
    expect([...shown].length).toBeLessThanOrEqual(60_000)
  })

  test('入参自己核对：files 与 continuation 只给一个，maxChars 至少给每个文件分到一个字符', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await projectSpaceFixture({ root })
    for (const input of [
      { path: 'a.txt' },
      { files: [{ path: 'a.txt' }], continuation: 'read-page:abc' },
      { files: [] },
      { files: [{ path: 'a.txt' }, { path: 'a.txt' }], maxChars: 1 },
      { files: [{ path: 'a.txt', range: [3, 1] }] },
      { continuation: 'view:abc' },
    ]) expect((await failureOf(call('project', 'read', input))).code, JSON.stringify(input)).toBe('INVALID_INPUT')
  })
})

describe('list', () => {
  test('分页按稳定顺序走，目录在两页之间变了 cursor 就作废', async () => {
    await mkdir(join(root, 'src'))
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(join(root, 'src', name), 'export {}\n')
    const { call } = await projectSpaceFixture({ root })
    const first = await call('project', 'list', { path: 'src', include: ['*.ts'], limit: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.truncated).toBe(true)
    expect(first.cursor).toStartWith('list-page:')
    const second = await call('project', 'list', { cursor: first.cursor, limit: 1 })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].path).not.toBe(first.entries[0].path)
    await writeFile(join(root, 'src/d.ts'), 'export {}\n')
    // 目录变了是「手里的东西过期了」，和续读页过期同一个码，下一步都是重新列。
    const stale = await failureOf(call('project', 'list', { cursor: second.cursor }))
    expect(stale.code).toBe('BASE_REVISION_MISMATCH')
    expect(stale.message).toContain('去掉 cursor')
  })

  test('depth 一个字段说清楚往下列几层：1 只列当前目录，缺省 3 层，all 是整棵树', async () => {
    await mkdir(join(root, 'src/deep/deeper/deepest'), { recursive: true })
    await writeFile(join(root, 'src/top.ts'), 'export {}\n')
    await writeFile(join(root, 'src/deep/deeper/deepest/leaf.ts'), 'export {}\n')
    const { call } = await projectSpaceFixture({ root })
    const paths = async (input: Record<string, unknown>) =>
      (await call('project', 'list', input)).entries.map((entry: { path: string }) => entry.path)
    expect(await paths({ path: 'src', depth: 1 })).toEqual(['src/deep', 'src/top.ts'])
    // 缺省三层：第四层的 leaf.ts 还看不到。
    expect(await paths({ path: 'src' })).toEqual(['src/deep', 'src/deep/deeper', 'src/deep/deeper/deepest', 'src/top.ts'])
    expect(await paths({ path: 'src', depth: 'all' })).toContain('src/deep/deeper/deepest/leaf.ts')
    // 不合法的层数、续页时换条件都当场拒绝。
    expect((await failureOf(call('project', 'list', { path: 'src', depth: 0 }))).code).toBe('INVALID_INPUT')
    expect((await failureOf(call('project', 'list', { cursor: 'list-page:x', depth: 2 }))).code).toBe('INVALID_INPUT')
  })
  test('glob 照 rg -g 的习惯：不带 / 的按文件名、任意深度都算，带 / 的从 path 起算；搜索的 glob 同样相对 path', async () => {
    await mkdir(join(root, 'src/lib'), { recursive: true })
    await writeFile(join(root, 'top.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'src/price.ts'), 'export const price = 1\n')
    await writeFile(join(root, 'src/lib/cart.ts'), 'export const price = 2\n')
    await writeFile(join(root, 'src/lib/cart.test.ts'), 'export const price = 3\n')
    await writeFile(join(root, 'src/notes.md'), 'price\n')
    const { call } = await projectSpaceFixture({ root })
    const listed = async (input: Record<string, unknown>) =>
      (await call('project', 'list', { depth: 'all', ...input })).entries.filter((entry: { type: string }) => entry.type === 'file').map((entry: { path: string }) => entry.path).sort()
    expect(await listed({ include: ['*.ts'] })).toEqual(['src/lib/cart.test.ts', 'src/lib/cart.ts', 'src/price.ts', 'top.ts'])
    expect(await listed({ path: 'src', include: ['*.ts'], exclude: ['*.test.ts'] })).toEqual(['src/lib/cart.ts', 'src/price.ts'])
    expect(await listed({ path: 'src', include: ['lib/*.ts'] })).toEqual(['src/lib/cart.test.ts', 'src/lib/cart.ts'])
    // 已经写成从项目根起的也认。
    expect(await listed({ path: 'src', include: ['src/lib/*.ts'] })).toEqual(['src/lib/cart.test.ts', 'src/lib/cart.ts'])

    const hits = async (input: Record<string, unknown>) =>
      (await call('project', 'search', { query: 'price', contextLines: 0, ...input })).hits.map((hit: { path: string }) => hit.path).sort()
    expect(await hits({ include: ['*.ts'] })).toEqual(['src/lib/cart.test.ts', 'src/lib/cart.ts', 'src/price.ts'])
    expect(await hits({ path: 'src/lib', include: ['*.ts'], exclude: ['*.test.ts'] })).toEqual(['src/lib/cart.ts'])
  })

  test('列一个不存在的目录、或者把文件当目录列，直说，不装成空目录', async () => {
    await writeFile(join(root, 'a.ts'), 'export {}\n')
    const { call } = await projectSpaceFixture({ root })
    expect((await failureOf(call('project', 'list', { path: 'nope' }))).code).toBe('TARGET_NOT_FOUND')
    expect((await failureOf(call('project', 'list', { path: 'a.ts' }))).code).toBe('INVALID_INPUT')
  })
})

describe('search', () => {
  test('字面与正则都搜得到；命中处的窗口带 fileRef，直接拿去改', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nneedle A\nsecond\nneedle B\nend\n')
    const { call } = await projectSpaceFixture({ root })
    const literal = await call('project', 'search', { query: 'needle A', regex: false, contextLines: 0 })
    expect(literal.hits).toHaveLength(1)
    const [window] = literal.files
    expect(window.lines).toEqual([[2, 'needle A']])
    expect(window.fileRef).toStartWith('view:')
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: window.fileRef, edits: [{ op: 'replace', match: 'needle A', text: 'changed A' }] }] })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nchanged A\nsecond\nneedle B\nend\n')
    const regex = await call('project', 'search', { query: '(changed|needle) [AB]', regex: true, caseSensitive: true, contextLines: 0 })
    expect(regex.hits).toHaveLength(2)
    expect(regex.files.every((file: { fileRef?: string }) => typeof file.fileRef === 'string')).toBe(true)
  })

  test('窗口只授权命中所在版本上真正给出的那几行', async () => {
    await writeFile(join(root, 'a.ts'), 'before\nconst target = 1\nafter\n')
    const { call, context } = await projectSpaceFixture({ root })
    const result = await call('project', 'search', { query: 'target' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].revision).toBeTruthy()
    const [window] = result.files
    expect(window.revision).toBe(result.hits[0].revision)
    expect(window.lines).toContainEqual([2, 'const target = 1'])
    const view = await loadFileView(context, window.fileRef)
    expect(view.coverage.map((range) => [range.startLine, range.endLine])).toEqual([[1, 3]])
  })

  test('窗口总量有上限：装不下的命中只留位置与片段，标成不可直接编辑', async () => {
    for (let index = 0; index < 100; index++)
      await writeFile(join(root, `hit-${index}.ts`), `// before\nexport const needle_${index} = ${index}\n// after\n`)
    const { call } = await projectSpaceFixture({ root })
    const result = await call('project', 'search', { query: 'needle', limit: 100, contextLines: 3 })
    expect(result.hits).toHaveLength(100)
    const windowed = new Set(result.files.map((window: { path: string }) => window.path))
    expect(windowed.size).toBeGreaterThan(0)
    expect(windowed.size).toBeLessThan(100)
    for (const hit of result.hits) {
      if (windowed.has(hit.path)) expect(hit.editable, hit.path).toBeUndefined()
      else expect(hit, hit.path).toMatchObject({ editable: false, snippet: expect.stringContaining('needle') })
    }
    expect(result.files.every((window: { fileRef?: string }) => window.fileRef?.startsWith('view:'))).toBe(true)
  })
})
