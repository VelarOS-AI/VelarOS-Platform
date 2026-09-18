/**
 * `velar:project` 的读的一侧：read 的源码窗口与 fileRef 覆盖、list、search 窗口，以及三者都不折叠、只有守内存的上限。
 * 一律经 `call('project', …)` 走真的代码面端口；fileRef 实际覆盖了什么用 `loadFileView` 核对。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ProjectFileLimits, ProjectPolicyDefaults } from '../contract/constants'
import { createSecretRedactionProvider } from '../index'
import { loadFileView } from '../utils/agent/file-refs'
import { projectSourceLines } from '../utils/agent/source-window'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-files-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

type Fixture = Awaited<ReturnType<typeof projectToolFixture>>

/** 读一个文件，交回它的第一个窗口。 */
async function readOne(call: Fixture['call'], path: string, range?: unknown) {
  return (await call('project', 'read', { files: [range === undefined ? { path } : { path, range }] })).files[0]
}

/** 凭一个 fileRef 改一处。 */
function editLine(call: Fixture['call'], fileRef: string, range: unknown, text: string) {
  return call('project', 'edit', { steps: [{ action: 'edit', fileRef, edits: [{ op: 'replace', range, text }] }] })
}

describe('read 的窗口与 fileRef', () => {
  test('fileRef 只授权真正交出去的那几行：窗口外的一行都改不了', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call, context } = await projectToolFixture({ root })
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
    const { call, context } = await projectToolFixture({ root })
    for (const range of [2, [2], [2, 2]]) {
      const window = await readOne(call, 'a.ts', range)
      expect(window.lines).toEqual([[2, '123|literal🙂\\n']])
      const view = await loadFileView(context, window.fileRef)
      expect(view.content).toBe(original)
      expect(view.coverage).toEqual([{ startOffset: 7, endOffset: original.indexOf('last'), startLine: 2, endLine: 2, completeLines: true }])
    }
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(original)
  })

  test('不给 range 就交回整个文件：一千行都在，fileRef 覆盖整个文件，最后一行照样改得了', async () => {
    const original = Array.from({ length: 1000 }, (_, index) => `line ${index + 1} 🙂`).join('\n')
    await writeFile(join(root, 'a.txt'), original)
    const { call, context } = await projectToolFixture({ root })
    const window = await readOne(call, 'a.txt')
    expect(window.lines).toHaveLength(1000)
    expect(window.lines.at(-1)).toEqual([1000, 'line 1000 🙂'])
    expect(window.totalLines).toBe(1000)
    // 模型面上没有续读、分段这些字段了。
    expect(window.hasMore).toBeUndefined()
    expect(window.continuation).toBeUndefined()
    expect(window.fragments).toBeUndefined()
    const view = await loadFileView(context, window.fileRef)
    expect(view.coverage).toEqual([{ startOffset: 0, endOffset: original.length, startLine: 1, endLine: 1000, completeLines: true }])
    await editLine(call, window.fileRef, 1000, 'last')
    expect((await readFile(join(root, 'a.txt'), 'utf8')).endsWith('line 999 🙂\nlast')).toBe(true)
  })

  test('一行再长也整行交回，fileRef 覆盖整行', async () => {
    const original = '🙂\\n"'.repeat(100_000)
    await writeFile(join(root, 'a.ts'), original)
    const { call, context } = await projectToolFixture({ root })
    const window = await readOne(call, 'a.ts')
    expect(window.lines).toEqual([[1, original]])
    const view = await loadFileView(context, window.fileRef)
    expect(view.coverage).toEqual([{ startOffset: 0, endOffset: original.length, startLine: 1, endLine: 1, completeLines: true }])
  })

  test('读到文件外时给空窗口并说明，不给编辑权', async () => {
    await writeFile(join(root, 'target.ts'), 'const a = 1\nconst b = 2\n')
    const { call } = await projectToolFixture({ root })
    const beyond = await readOne(call, 'target.ts', [99, 100])
    // 行数照 wc -l 数，说明也照它写。
    expect(beyond).toMatchObject({ lines: [], totalLines: 2, editable: false })
    expect(beyond.fileRef).toBeUndefined()
    expect(beyond.note).toContain('文件共 2 行')
    expect(beyond.note).toContain('超出范围')
    // 从最后一行的下一行起读：那里只有结尾换行之后那个零宽的行，不给模型看，但末尾照样插得进去。
    const tail = await readOne(call, 'target.ts', [3, 5])
    expect(tail).toMatchObject({ lines: [], totalLines: 2 })
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: tail.fileRef, edits: [{ op: 'insert', at: 'end', text: 'const c = 3' }] }] })
    expect(await readFile(join(root, 'target.ts'), 'utf8')).toBe('const a = 1\nconst b = 2\nconst c = 3\n')
    await writeFile(join(root, 'target.ts'), 'const a = 1\nconst b = 2\n')
    expect(await readFile(join(root, 'target.ts'), 'utf8')).toBe('const a = 1\nconst b = 2\n')
  })

  test('fileRef 只在签发它的会话里有效；正文变了就作废，哪怕版本号没变', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    const { call, context, kernel } = await projectToolFixture({ root })
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

  test('行数照 wc -l 数：结尾换行之后那个零宽的行不给模型看，但在可见范围里，末尾照样插得进去', async () => {
    const { call, context } = await projectToolFixture({ root })
    for (const [original, lines] of [['', []], ['line\n', [[1, 'line']]], ['a\n\n', [[1, 'a'], [2, '']]], ['a\nb', [[1, 'a'], [2, 'b']]]] as const) {
      await writeFile(join(root, 'a.ts'), original)
      const window = await readOne(call, 'a.ts')
      expect(window.lines, JSON.stringify(original)).toEqual(lines)
      expect(window.totalLines, JSON.stringify(original)).toBe(lines.length)
      const view = await loadFileView(context, window.fileRef)
      expect(view.coverage.at(-1)?.completeLines).toBe(true)
      expect(view.coverage.at(-1)?.endOffset).toBe(original.length)
    }
    // 按范围读到最后一行真实的行，就算读到头了：没有续读，末尾插入要的那个零宽的行也在可见范围里。
    await writeFile(join(root, 'a.ts'), 'a\n\n')
    const ranged = await readOne(call, 'a.ts', [1, 2])
    expect(ranged.lines).toEqual([[1, 'a'], [2, '']])
    expect(ranged.hasMore).toBeUndefined()
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: ranged.fileRef, edits: [{ op: 'insert', at: 'end', text: 'z' }] }] })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('a\n\nz\n')
    // 只有 \n 与 \r\n 算换行，孤立的 \r 是行里的字符。
    expect(projectSourceLines('a\r\nb\rc').map((line) => line.text)).toEqual(['a', 'b\rc'])
  })

  test('同一份源码不相连的几个窗口共用一个 fileRef，中间没读的行照样改不了', async () => {
    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\nfive')
    const { call, context } = await projectToolFixture({ root })
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

  test('路径钳在项目里：项目里的绝对路径也认，出了项目就拒', async () => {
    await writeFile(join(root, 'a.txt'), 'inside\n')
    const { call } = await projectToolFixture({ root })
    expect((await readOne(call, join(root, 'a.txt'))).lines).toEqual([[1, 'inside']])
    const outside = await failureOf(readOne(call, '../outside.txt'))
    expect(outside.code).toBe('PERMISSION_DENIED')
    expect(outside.message).toContain('项目之内')
  })

  test('像密钥的片段读出来是遮住的，这样的窗口只能看、不能改', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    await writeFile(join(root, 'env.ts'), `const token = "${secret}"\nconst plain = 1\n`)
    const { call } = await projectToolFixture({ root, providers: { secretRedaction: createSecretRedactionProvider() } })
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
    const { call } = await projectToolFixture({ root })
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
    const { call } = await projectToolFixture({ root })
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
    const { call } = await projectToolFixture({ root, corePolicy: { readDeny: ['denied.txt'] } })
    const result = await call('project', 'read', { files: [{ path: 'denied.txt' }, { path: 'open.txt', range: 1 }] })
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(['open.txt'])
    expect(result.files[0].fileRef).toStartWith('view:')
    expect(result.issues).toEqual([expect.objectContaining({ path: 'denied.txt', code: 'PERMISSION_DENIED' })])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  test('批量读每个文件都整份交回，各带 fileRef', async () => {
    const modules = Array.from({ length: 6 }, (_, index) => `module-${index}.ts`)
    for (const [index, path] of modules.entries()) {
      const lines = Array.from({ length: 120 }, (_, line) => `export const value_${index}_${line} = "中文🙂 ${'x'.repeat(28)}" // beacon`)
      await writeFile(join(root, path), `${lines.join('\n')}\n`)
    }
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'read', { files: modules.map((path) => ({ path })) })
    expect(result.issues).toBeUndefined()
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(modules)
    for (const [index, window] of result.files.entries()) {
      expect(window.lines, window.path).toHaveLength(120)
      expect(window.lines.at(-1), window.path).toEqual([120, `export const value_${index}_119 = "中文🙂 ${'x'.repeat(28)}" // beacon`])
      expect(window.fileRef, window.path).toStartWith('view:')
    }
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
      return input.path === 'big.txt' ? { ...value, content: '', truncated: true, hasMore: true } : value
    }
    const result = await call('project', 'read', { files: [{ path: 'a.txt' }, { path: 'big.txt' }] })
    expect(result.files.map((window: { path: string }) => window.path)).toEqual(['a.txt'])
    expect(result.issues).toEqual([expect.objectContaining({ path: 'big.txt', code: 'SCOPE_VIOLATION', next: '单独读它，或者用 range 分几段读。' })])
    // 上限是整次调用共用的：a.txt 交回了多少，big.txt 能用的就少多少。
    expect(budgets.filter(([path]) => path === 'a.txt')[0]).toEqual(['a.txt', ProjectFileLimits.readChars])
    expect(budgets.filter(([path]) => path === 'big.txt')[0]).toEqual(['big.txt', ProjectFileLimits.readChars - 100])
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
    ]) expect((await failureOf(call('project', 'read', input))).code, JSON.stringify(input)).toBe('INVALID_INPUT')
  })
})

describe('list', () => {
  test('交回全部条目，按深度优先的稳定顺序：不给 depth 是整棵树，depth 1 只列当前目录', async () => {
    await mkdir(join(root, 'src/deep/deeper/deepest'), { recursive: true })
    await writeFile(join(root, 'src/top.ts'), 'export {}\n')
    await writeFile(join(root, 'src/deep/deeper/deepest/leaf.ts'), 'export {}\n')
    const { call } = await projectToolFixture({ root })
    const listed = async (input: Record<string, unknown>) => call('project', 'list', input)
    const paths = async (input: Record<string, unknown>) => (await listed(input)).entries.map((entry: { path: string }) => entry.path)
    expect(await paths({ path: 'src' })).toEqual(['src/deep', 'src/deep/deeper', 'src/deep/deeper/deepest', 'src/deep/deeper/deepest/leaf.ts', 'src/top.ts'])
    expect(await paths({ path: 'src', depth: 1 })).toEqual(['src/deep', 'src/top.ts'])
    expect(await paths({ path: 'src', depth: 2 })).toEqual(['src/deep', 'src/deep/deeper', 'src/top.ts'])
    // 回执里只有条目：没有分页、没有截断标记。
    expect(Object.keys(await listed({ path: 'src' }))).toEqual(['entries'])
    // 不合法的层数当场拒绝；'all' 不再是一个值，不给 depth 就是整棵树。
    for (const depth of [0, ProjectFileLimits.listDepth + 1, 'all']) {
      expect((await failureOf(listed({ path: 'src', depth }))).code, String(depth)).toBe('INVALID_INPUT')
    }
  })

  test('条目超过守内存的上限时整个失败，不交回一部分冒充全部', async () => {
    const { call, kernel } = await projectToolFixture({ root })
    const requested: Array<Optional<number>> = []
    kernel.listFiles = async (input) => {
      requested.push(input?.maxFiles)
      return Array.from({ length: (input?.maxFiles ?? 0) }, (_, index) => ({ path: `f${index}.ts`, type: 'file' as const }))
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
      (await call('project', 'list', input)).entries.filter((entry: { type: string }) => entry.type === 'file').map((entry: { path: string }) => entry.path).sort()
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
    const { call } = await projectToolFixture({ root })
    expect((await failureOf(call('project', 'list', { path: 'nope' }))).code).toBe('TARGET_NOT_FOUND')
    expect((await failureOf(call('project', 'list', { path: 'a.ts' }))).code).toBe('INVALID_INPUT')
  })
})

describe('search', () => {
  test('字面与正则都搜得到；命中处的窗口带 fileRef，直接拿去改', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nneedle A\nsecond\nneedle B\nend\n')
    const { call } = await projectToolFixture({ root })
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
    const { call, context } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'target' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].revision).toBeTruthy()
    const [window] = result.files
    expect(window.revision).toBe(result.hits[0].revision)
    expect(window.lines).toContainEqual([2, 'const target = 1'])
    const view = await loadFileView(context, window.fileRef)
    // 窗口给到了最后一行，结尾换行之后那个零宽的行（内核里的第 4 行）也在可见范围里：在末尾插入要它。
    expect(view.coverage.map((range) => [range.startLine, range.endLine])).toEqual([[1, 4]])
  })

  test('交回全部命中：一百个文件一百个窗口，每个都带 fileRef、能直接改', async () => {
    for (let index = 0; index < 100; index++)
      await writeFile(join(root, `hit-${index}.ts`), `// before\nexport const needle_${index} = ${index}\n// after\n`)
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'needle', contextLines: 3 })
    expect(result.hits).toHaveLength(100)
    expect(result.truncated).toBeUndefined()
    expect(new Set(result.files.map((window: { path: string }) => window.path)).size).toBe(100)
    for (const hit of result.hits) expect(hit.editable, hit.path).toBeUndefined()
    expect(result.files.every((window: { fileRef?: string }) => window.fileRef?.startsWith('view:'))).toBe(true)
  })

  test('一个文件里的几处命中合成一个窗口：只有命中附近的行，中间没给的行改不了', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    lines[1] = 'needle one'
    lines[19] = 'needle two'
    await writeFile(join(root, 'a.txt'), `${lines.join('\n')}\n`)
    const { call, context } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'needle' })
    expect(result.hits.map((hit: { range: { startLine: number } }) => hit.range.startLine)).toEqual([2, 20])
    expect(result.files).toHaveLength(1)
    const [window] = result.files
    expect(window.lines.map(([line]: [number, string]) => line)).toEqual([1, 2, 3, 19, 20, 21])
    expect(window.totalLines).toBe(30)
    const view = await loadFileView(context, window.fileRef)
    expect(view.coverage.map((range) => [range.startLine, range.endLine])).toEqual([[1, 3], [19, 21]])
    expect((await failureOf(editLine(call, window.fileRef, 10, 'x'))).code).toBe('SCOPE_VIOLATION')
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: window.fileRef, edits: [{ op: 'replace', range: 2, text: 'ONE' }, { op: 'replace', range: 20, text: 'TWO' }] }] })
    expect((await readFile(join(root, 'a.txt'), 'utf8')).split('\n').filter((line) => line === 'ONE' || line === 'TWO')).toEqual(['ONE', 'TWO'])
  })

  test('命中超过守内存的上限、或者搜索没能收全（超时）时整个失败，不交回一部分冒充全部', async () => {
    const { call, kernel } = await projectToolFixture({ root })
    const requested: Array<Optional<number>> = []
    const hit = (index: number) => ({ path: `f${index}.ts`, revision: 'r', score: 1, kind: 'text' as const, range: { startLine: 1, endLine: 1 } })
    kernel.search = async (input) => {
      requested.push(input.maxResults)
      return { query: input.query, hits: Array.from({ length: input.maxResults ?? 0 }, (_, index) => hit(index)), truncated: true }
    }
    const tooMany = await failureOf(call('project', 'search', { query: 'x' }))
    expect(tooMany.code).toBe('SCOPE_VIOLATION')
    expect(tooMany.message).toContain(String(ProjectFileLimits.searchHits))
    expect(tooMany.message).toContain('收窄 query、path 或 include')
    expect(requested).toEqual([ProjectFileLimits.searchHits + 1])
    kernel.search = async (input) => ({ query: input.query, hits: [hit(0)], truncated: true, diagnostics: ['ripgrep 搜索超过 120000 毫秒超时'] })
    const timedOut = await failureOf(call('project', 'search', { query: 'x' }))
    expect(timedOut.code).toBe('SCOPE_VIOLATION')
    expect(timedOut.message).toContain('超时')
  })

  test('内核的搜索不按文件截命中：一个文件上千处命中照样全部交回', async () => {
    await writeFile(join(root, 'many.ts'), `${Array.from({ length: 1200 }, (_, index) => `hit ${index}`).join('\n')}\n`)
    const { call } = await projectToolFixture({ root })
    const result = await call('project', 'search', { query: 'hit', contextLines: 0 })
    expect(result.hits).toHaveLength(1200)
    expect(result.files[0].lines).toHaveLength(1200)
  })
})
