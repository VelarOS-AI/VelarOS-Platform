import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'

import { projectTools } from '../src/agent/Project.tool'
import {
  type AgentProjectKernelPort,
  executeAgentProjectRead,
  executeAgentProjectSearch,
} from '../src/agent/ProjectKernelPort'
import type { ProjectToolContext } from '../src/agent/Types'
import { ProjectEditOperationSchema } from '../src/edit-schema'
import { createProjectKernel, type EditOperation, typescriptPlugin } from '../src/index'
import { ProjectToolNames } from '../src/project-tool-names'
import { includesLineEndingAware } from '../src/utils/text'
import { diagnoseTextMatchMiss, findLineWhitespaceTolerantMatches } from '../src/utils/text-match-feedback'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'velaros-project-ai-feedback-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
}

async function prepareFailure(operation: EditOperation): Promise<any> {
  const project = await createProjectKernel({ root })
  try {
    await project.prepareEdit({ operations: [{ operation }] })
  } catch (error) {
    return error
  }
  throw new Error('prepareEdit 应当失败')
}

function toolContext(): ProjectToolContext {
  return {
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      runInDirectory: async (_path, action) => action(),
      kernel: async () => createProjectKernel({ root }),
      runWithApproval: async (action) => action(),
      prepareMutation: async () => ({
        approved: true,
        rootPath: root,
        switched: false,
        alreadyAuthorized: true,
        rejectionMessage: null,
        message: 'approved',
        authorizationScope: 'project',
      }),
      runCommand: async () => ({}) as never,
      queryCode: async () => ({}),
    },
    system: { canStartBackgroundCommands: () => false },
    approval: defaultDenyApprovalPort,
  }
}

describe('project:read range clamping', () => {
  test('a batch range beyond one short file keeps every other file and explains the short one', async () => {
    await writeFile(join(root, 'long.txt'), numberedLines(200))
    await writeFile(join(root, 'short.txt'), numberedLines(3))
    const project = await createProjectKernel({ root })

    const result = await executeAgentProjectRead(project, {
      path: ['long.txt', 'short.txt'],
      range: { startLine: 150, endLine: 400 },
      maxChars: 280_000,
    }, { rootPath: root })

    expect(result.issues).toBeUndefined()
    expect(result.files[0]?.content?.split('\n')[0]).toBe('line 150')
    expect(result.files[0]?.content?.split('\n').at(-1)).toBe('line 200')
    expect(result.files[1]).toMatchObject({
      snapshot: { path: 'short.txt', exists: true },
      content: '',
      totalLines: 3,
      hasMore: false,
    })
    expect(result.files[1]?.note).toContain('文件共 3 行')
    expect(result.files[1]?.note).toContain('起始行 150')
  })

  test('a single out-of-range read returns a note instead of failing on both read paths', async () => {
    await writeFile(join(root, 'small.txt'), 'abc')
    await writeFile(join(root, 'streamed.txt'), 'abcdefghij\nsecond')
    const project = await createProjectKernel({ root, corePolicy: { maxFileSizeToReadBytes: 8 } })

    for (const [path, totalLines] of [['small.txt', 1], ['streamed.txt', 2]] as const) {
      const read = await project.read({ path, range: { startLine: 9 } })
      expect(read).toMatchObject({ content: '', totalLines, truncated: false, hasMore: false })
      expect(read.note).toContain(`文件共 ${totalLines} 行`)
    }
  })

  test('clamps an endLine beyond the file and drops the endColumn it can no longer anchor', async () => {
    await writeFile(join(root, 'small.txt'), 'abc\ndef')
    await writeFile(join(root, 'streamed.txt'), 'abcdefghij\nsecond')
    const project = await createProjectKernel({ root, corePolicy: { maxFileSizeToReadBytes: 8 } })

    const small = await project.read({ path: 'small.txt', range: { startLine: 1, endLine: 5, endColumn: 2 } })
    expect(small.content).toBe('abc\ndef')
    expect(small.note).toContain('忽略 endColumn')
    const streamed = await project.read({ path: 'streamed.txt', range: { startLine: 2, endLine: 5, endColumn: 2 } })
    expect(streamed.content).toBe('second')
    expect(streamed.note).toContain('忽略 endColumn')
    const plain = await project.read({ path: 'small.txt', range: { startLine: 1, endLine: 5 } })
    expect(plain.content).toBe('abc\ndef')
    expect(plain.note).toBeUndefined()
  })

  test('isolates per-file failures in a batch as path-bearing issues, but still throws for one file', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n')
    const project = await createProjectKernel({ root })

    const batch = await executeAgentProjectRead(project, {
      path: ['a.txt', 'b.txt'],
      baseRevisions: { 'a.txt': 'stale-revision' },
    }, { rootPath: root })
    expect(batch.files.map((file) => file.snapshot.path)).toEqual(['b.txt'])
    expect(batch.issues).toEqual([{
      path: 'a.txt',
      reason: 'failed',
      code: 'BASE_REVISION_MISMATCH',
      message: expect.stringContaining('a.txt'),
    }])
    expect(batch.nextAction).toContain('只重读这些路径')

    await expect(executeAgentProjectRead(project, {
      path: 'a.txt',
      baseRevisions: { 'a.txt': 'stale-revision' },
    }, { rootPath: root })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
  })

  test('rejects a file-independent range error once for the whole batch', async () => {
    await writeFile(join(root, 'big.txt'), numberedLines(30))
    await writeFile(join(root, 'short.txt'), numberedLines(3))
    const project = await createProjectKernel({ root })

    const error = await executeAgentProjectRead(project, {
      path: ['big.txt', 'short.txt'],
      range: { startLine: 10, endLine: 2 },
    }, { rootPath: root }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ reason: 'INVALID_INPUT', message: '读取范围的 endLine 不能早于 startLine' })

    // 与具体文件相关的列越界仍逐文件隔离：只有第 1 行不够长的文件记为 issue。
    await writeFile(join(root, 'wide.txt'), 'a much longer first line\nsecond')
    const columns = await executeAgentProjectRead(project, {
      path: ['wide.txt', 'short.txt'],
      range: { startLine: 1, startColumn: 12 },
    }, { rootPath: root })
    expect(columns.files.map((file) => file.snapshot.path)).toEqual(['wide.txt'])
    expect(columns.issues).toEqual([expect.objectContaining({ path: 'short.txt', reason: 'failed', code: 'INVALID_INPUT' })])
    expect(columns.nextAction).toBeDefined()
  })

  test('keeps the remaining column errors but names the file', async () => {
    await writeFile(join(root, 'cols.txt'), 'abc')
    const project = await createProjectKernel({ root })
    await expect(project.read({ path: 'cols.txt', range: { startLine: 1, startColumn: 9 } })).rejects.toMatchObject({
      reason: 'INVALID_INPUT',
      message: expect.stringContaining('cols.txt'),
      details: { path: 'cols.txt', lineLength: 3 },
    })
  })

  test('describes per-file clamping in the read tool contract', () => {
    const description = projectTools[ProjectToolNames.read].description
    expect(description).toContain('range 对每个文件逐个应用')
    expect(description).toContain('note')
  })
})

describe('text anchor miss diagnostics', () => {
  const source = [
    'export function render(template: string) {',
    '  const pattern = /\\{([^}]*)\\}/g',
    '  return template.replace(pattern, (_, key) => lookup(key))',
    '}',
    '',
    'function lookup(key: string) {',
    '  const content = input.snapshot.content ?? "";',
    "  return key.split('\\n')",
    '}',
    '',
    'function other(key: string) {',
    '  const content = input.snapshot.content ?? "";',
    '  return key',
    '}',
    '',
  ].join('\n')

  test('pinpoints a backslash escape difference with the diverging line', async () => {
    await writeFile(join(root, 'render.ts'), source)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'render.ts',
      oldText: 'export function render(template: string) {\n  const pattern = /\\\\{([^}]*)\\\\}/g\n  return template',
      newText: 'x',
      expectedMatches: 1,
    })

    expect(error.reason).toBe('TARGET_NOT_FOUND')
    expect(error.details).toMatchObject({
      expected: 1,
      actual: 0,
      candidateLine: 1,
      matchedLines: 1,
      causes: ['backslash_escape'],
      firstMismatch: {
        oldTextLine: 2,
        fileLine: 2,
        expected: '  const pattern = /\\\\{([^}]*)\\\\}/g',
        actual: '  const pattern = /\\{([^}]*)\\}/g',
      },
    })
    expect(error.details.hint).toContain('oldText 该行 4 个，文件 2 个')
    // 宿主可能只把 message 转给模型，定位线索必须也在消息里。
    expect(error.message).toContain('文件第 2 行')
    expect(error.message).toContain('反斜杠')
    expect(error.suggestedNextAction).toContain('第 1–5 行')
  })

  test('reports an indentation difference without applying an indentation-insensitive match', async () => {
    await writeFile(join(root, 'render.ts'), source)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'render.ts',
      oldText: 'function lookup(key: string) {\n    const content = input.snapshot.content ?? "";',
      newText: 'x',
    })

    expect(error.details).toMatchObject({
      candidateLine: 6,
      causes: ['indentation'],
      firstMismatch: { oldTextLine: 2, fileLine: 7 },
    })
    expect(error.details.hint).toContain('oldText：4 个空格，文件：2 个空格')
    expect(await readFile(join(root, 'render.ts'), 'utf8')).toBe(source)
  })

  test('keeps indentation strict for whitespace-significant files', async () => {
    const yaml = 'root:\n  child:\n    value: 1\n'
    await writeFile(join(root, 'config.yaml'), yaml)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'config.yaml',
      oldText: 'child:\n  value: 1',
      newText: 'child:\n  value: 2',
    })
    expect(error.reason).toBe('TARGET_NOT_FOUND')
    expect(error.details.causes).toEqual(['indentation'])
  })

  test('does not blame CRLF when the file is CRLF and the real difference is content', async () => {
    await writeFile(join(root, 'win.txt'), 'first\r\nsecond value\r\nthird\r\n')
    const error = await prepareFailure({
      type: 'delete_text',
      path: 'win.txt',
      oldText: 'first\nsecond valve\nthird',
    })
    expect(error.details).toMatchObject({
      candidateLine: 1,
      causes: ['content'],
      firstMismatch: { oldTextLine: 2, fileLine: 2, expected: 'second valve', actual: 'second value' },
    })
  })

  test('locates a single-line oldText whose only difference is backslash escaping', async () => {
    await writeFile(join(root, 'render.ts'), source)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'render.ts',
      oldText: '  const pattern = /\\\\{([^}]*)\\\\}/g',
      newText: 'x',
    })
    expect(error.details).toMatchObject({
      candidateLine: 2,
      causes: ['backslash_escape'],
      firstMismatch: { oldTextLine: 1, fileLine: 2, actual: '  const pattern = /\\{([^}]*)\\}/g' },
    })
    expect(error.message).toContain('反斜杠')
  })

  test('locates oldText when every line carries an escaping difference', async () => {
    await writeFile(join(root, 'escapes.ts'), 'const a = "\\n"\nconst b = "\\t"\n')
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'escapes.ts',
      oldText: 'const a = "\\\\n"\nconst b = "\\\\t"',
      newText: 'x',
    })
    expect(error.details).toMatchObject({ candidateLine: 1, causes: ['backslash_escape'], firstMismatch: { oldTextLine: 1 } })
  })

  test('locates a single-line typo through the nearest similar line', async () => {
    await writeFile(join(root, 'render.ts'), source)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'render.ts',
      oldText: '  return template.replace(pattren, (_, key) => lookup(key))',
      newText: 'x',
    })
    expect(error.details).toMatchObject({
      candidateLine: 3,
      causes: ['content'],
      firstMismatch: { oldTextLine: 1, fileLine: 3, actual: '  return template.replace(pattern, (_, key) => lookup(key))' },
    })
    expect(error.message).not.toContain('任何非空行都不在文件中')
  })

  test('skips tolerated whitespace and line-ending differences when naming the first mismatch', async () => {
    await writeFile(join(root, 'ws.ts'), 'function a() {  \n  const x = 1\n  const y = "\\n"\n}\n')
    const trailing = await prepareFailure({
      type: 'replace_text',
      path: 'ws.ts',
      oldText: 'function a() {\n  const x = 1\n  const y = "\\\\n"\n}',
      newText: 'x',
    })
    expect(trailing.details).toMatchObject({
      candidateLine: 1,
      matchedLines: 2,
      causes: ['backslash_escape'],
      tolerated: ['trailing_whitespace'],
      firstMismatch: { oldTextLine: 3, fileLine: 3 },
    })
    expect(trailing.message).toContain('无需修正')

    await writeFile(join(root, 'lf.txt'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')
    const crlf = await prepareFailure({
      type: 'replace_text',
      path: 'lf.txt',
      oldText: 'const alpha = 1\r\nconst beta = 2\r\nconst gamm = 3',
      newText: 'x',
    })
    expect(crlf.details).toMatchObject({
      causes: ['content'],
      tolerated: ['line_ending'],
      firstMismatch: { oldTextLine: 3, fileLine: 3, expected: 'const gamm = 3', actual: 'const gamma = 3' },
    })
  })

  test('lets rare anchor lines win over very common ones when picking the candidate', async () => {
    const blocks = Array.from({ length: 300 }, (_, index) => `function f${index}() {\n  return null;\n}`).join('\n')
    await writeFile(join(root, 'many.ts'), `${blocks}\nfunction target() {\n  return null;\n}\nfunction next() {\n  const re = /\\d+/\n}\n`)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'many.ts',
      oldText: '  return null;\n}\nfunction next() {\n  const re = /\\\\d+/',
      newText: 'x',
    })
    expect(error.details).toMatchObject({
      candidateLine: 902,
      causes: ['backslash_escape'],
      firstMismatch: { oldTextLine: 4, fileLine: 905 },
    })
  })

  test('explains text that appears nowhere in the file', async () => {
    await writeFile(join(root, 'render.ts'), source)
    const error = await prepareFailure({
      type: 'insert_text_at_anchor',
      path: 'render.ts',
      anchorText: 'completely absent\nnothing like this',
      position: 'after',
      text: 'x',
    })
    expect(error.reason).toBe('TARGET_NOT_FOUND')
    expect(error.details).toMatchObject({ causes: ['absent'], oldTextLines: 2 })
    expect(error.details.candidateLine).toBeUndefined()
    expect(error.message).toContain('任何非空行都不在文件中')
  })

  test('reports the end of file when oldText runs past it', async () => {
    await writeFile(join(root, 'short.txt'), 'alpha\nbeta')
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'short.txt',
      oldText: 'alpha\nbeta\ngamma',
      newText: 'x',
    })
    expect(error.details).toMatchObject({
      causes: ['end_of_file'],
      firstMismatch: { oldTextLine: 3, fileLine: 3, actual: null },
    })
  })

  test('names the real divergence when the last oldText line stops mid-line after tolerated whitespace', async () => {
    await writeFile(join(root, 'mid.ts'), 'foo\nconst x = 1;\n')
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'mid.ts',
      oldText: 'foo \nconst y = ',
      newText: 'x',
    })
    expect(error.details).toMatchObject({
      candidateLine: 1,
      matchedLines: 1,
      causes: ['content'],
      tolerated: ['trailing_whitespace'],
      firstMismatch: { oldTextLine: 2, fileLine: 2, expected: 'const y = ', actual: 'const x = 1;' },
    })
    expect(error.message).toContain('该行内容与文件不同')
  })

  test('always names a cause and agrees with the tolerant matcher on generated near-misses', () => {
    const variantsOf = (line: string) => [
      `${line} `,
      `${line}\t`,
      line.trimStart(),
      `  ${line}`,
      line.replace(/\\/g, '\\\\'),
      line.replace(/"/g, "'"),
      `${line.slice(0, 3)}#${line.slice(3)}`,
    ]
    const lines = source.split('\n')
    const failures: Array<{ content: string; needle: string; diagnosis: unknown }> = []
    for (const content of [source, source.replace(/\n/g, '\r\n')]) {
      for (let start = 0; start < lines.length; start += 1) {
        for (let size = 1; size <= 3 && start + size <= lines.length; size += 1) {
          const window = lines.slice(start, start + size)
          const last = window[size - 1]
          // 末行既取整行，也取停在每个空格之后的前缀：这正是 oldText 停在行中间的形态。
          const cuts = [last.length, ...[...last].flatMap((char, index) => char === ' ' ? [index + 1] : [])]
          for (const cut of cuts) {
            const base = [...window.slice(0, -1), last.slice(0, cut)]
            for (const [target, line] of base.entries()) {
              for (const variant of variantsOf(line)) {
                const needle = base.map((other, index) => index === target ? variant : other).join('\n')
                if (includesLineEndingAware(content, needle)) continue
                const diagnosis = diagnoseTextMatchMiss(content, needle)
                const unexplained = diagnosis.causes.length === 0 || /^[；。]/.test(diagnosis.hint)
                const unmatchedAgreement = diagnosis.candidateLine !== undefined && diagnosis.firstMismatch === undefined
                  && findLineWhitespaceTolerantMatches(content, needle, 1).length === 0
                if (unexplained || unmatchedAgreement) failures.push({ content, needle, diagnosis })
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
  })
})

describe('whitespace-tolerant text matching', () => {
  test('applies a unique match that differs only in trailing whitespace and says so', async () => {
    await writeFile(join(root, 'note.ts'), 'const a = 1   \nconst b = 2\n')
    const result = await projectTools[ProjectToolNames.edit].execute({
      operations: [{
        operation: {
          type: 'replace_text',
          path: 'note.ts',
          oldText: 'const a = 1\nconst b = 2',
          newText: 'const a = 10\nconst b = 20',
          expectedMatches: 1,
        },
      }],
    }, toolContext())

    expect(await readFile(join(root, 'note.ts'), 'utf8')).toBe('const a = 10\nconst b = 20\n')
    expect(result.notes).toEqual([expect.stringContaining('行尾空白或换行符')])
  })

  test('matches CRLF oldText against an LF file and keeps the file on LF', async () => {
    await writeFile(join(root, 'unix.txt'), 'one\ntwo\nthree\n')
    const project = await createProjectKernel({ root })
    const transaction = await project.prepareEdit({
      operations: [{
        operation: { type: 'replace_text', path: 'unix.txt', oldText: 'one\r\ntwo', newText: 'uno\r\ndos' },
      }],
    })
    expect(transaction.patches[0]?.metadata?.matchNote).toContain('第 1 行')
    await project.applyEdit({ transactionId: transaction.transactionId })
    expect(await readFile(join(root, 'unix.txt'), 'utf8')).toBe('uno\ndos\nthree\n')
  })

  test('only tolerates stripped whitespace that really sits at the end of a line', async () => {
    const cases = [
      { file: 'notes.md', content: 'config: const xyz = 1\n', operation: { type: 'replace_text', oldText: 'const x ', newText: 'const y ' } },
      { file: 'notes.md', content: 'price 100\n', operation: { type: 'insert_text_at_anchor', anchorText: 'price 1 ', position: 'after', text: 'X' } },
      { file: 'call.txt', content: 'call(foo,bar)\n', operation: { type: 'delete_text', oldText: 'foo, ' } },
      { file: 'a.json', content: '{"key":"value"}\n', operation: { type: 'replace_text', oldText: '"key": ', newText: '"k": ' } },
      { file: 'p.py', content: 'def f():\n    print("hello")\n', operation: { type: 'replace_text', oldText: 'def f():\n    print("hello ', newText: 'def f():\n    print("hi ' } },
    ] as const
    for (const { file, content, operation } of cases) {
      await writeFile(join(root, file), content)
      const error = await prepareFailure({ ...operation, path: file } as EditOperation)
      expect(error.reason).toBe('TARGET_NOT_FOUND')
      expect(error.details.whitespaceTolerantMatches).toBeUndefined()
      expect(await readFile(join(root, file), 'utf8')).toBe(content)
    }

    // 同样的单行 oldText 落在真正的行尾时仍可宽容应用。
    await writeFile(join(root, 'price.txt'), 'price 1\nnext\n')
    const project = await createProjectKernel({ root })
    const transaction = await project.prepareEdit({
      operations: [{ operation: { type: 'insert_text_at_anchor', path: 'price.txt', anchorText: 'price 1 ', position: 'after', text: 'X' } }],
    })
    expect(transaction.patches[0]?.metadata?.matchNote).toContain('行尾空白')
    await project.applyEdit({ transactionId: transaction.transactionId })
    expect(await readFile(join(root, 'price.txt'), 'utf8')).toBe('price 1X\nnext\n')
  })

  test('tolerates earlier trailing whitespace when the last line stops mid-line and matches its tail verbatim', async () => {
    const project = await createProjectKernel({ root })
    const cases = [
      { file: 'mid.ts', content: 'foo\nconst x = 1;\n', oldText: 'foo \nconst x = ', newText: 'bar\nconst x = ', after: 'bar\nconst x = 1;\n' },
      { file: 'indent.txt', content: 'foo \n  bar\n', oldText: 'foo\n  ', newText: 'baz\n    ', after: 'baz\n    bar\n' },
    ]
    for (const { file, content, oldText, newText, after } of cases) {
      await writeFile(join(root, file), content)
      const transaction = await project.prepareEdit({ operations: [{ operation: { type: 'replace_text', path: file, oldText, newText } }] })
      expect(transaction.patches[0]?.metadata?.matchNote).toContain('行尾空白')
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, file), 'utf8')).toBe(after)
    }
  })

  test('keeps each region of a mixed line-ending file on its own line ending', async () => {
    const content = 'x\r\ny\r\nfoo\nbar\n'
    const cases = [
      // 宽容匹配：oldText 是 CRLF、命中的是 LF 区域。
      { oldText: 'foo\r\nbar', newText: 'FOO\r\nBAR', after: 'x\r\ny\r\nFOO\nBAR\n' },
      // 精确匹配命中 LF 区域。
      { oldText: 'foo\nbar', newText: 'FOO\nBAR', after: 'x\r\ny\r\nFOO\nBAR\n' },
      // 精确匹配命中 CRLF 区域。
      { oldText: 'x\ny', newText: 'X\nY', after: 'X\r\nY\r\nfoo\nbar\n' },
    ]
    for (const { oldText, newText, after } of cases) {
      await writeFile(join(root, 'mixed.txt'), content)
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({ operations: [{ operation: { type: 'replace_text', path: 'mixed.txt', oldText, newText } }] })
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'mixed.txt'), 'utf8')).toBe(after)
    }
  })

  test('refuses a tolerant match that is not unique and lists where it would land', async () => {
    const content = 'value = 1  \nnext\nvalue = 1\t\nnext\n'
    await writeFile(join(root, 'dup.txt'), content)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'dup.txt',
      oldText: 'value = 1 \nnext',
      newText: 'x',
    })
    expect(error.reason).toBe('TARGET_NOT_FOUND')
    expect(error.details.whitespaceTolerantMatches.map((match: { line: number }) => match.line)).toEqual([1, 3])
    expect(error.message).toContain('未自动应用')
    expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe(content)
  })

  test('does not apply a tolerant match that contradicts the count assertion', async () => {
    await writeFile(join(root, 'one.txt'), 'alpha  \nbeta\n')
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'one.txt',
      oldText: 'alpha\nbeta',
      newText: 'x',
      expectedMatches: 2,
    })
    expect(error.reason).toBe('TARGET_NOT_FOUND')
    expect(error.details.whitespaceTolerantMatches).toHaveLength(1)
  })
})

describe('text feedback with the TypeScript plugin installed', () => {
  test('keeps diagnostics, tolerant matching, and read clamping on the Desktop assembly', async () => {
    await writeFile(join(root, 'mod.ts'), 'export function run() {\n  return "a\\\\b"  \n}\n')
    const project = await createProjectKernel({ root, plugins: [typescriptPlugin()] })

    const miss = await project.prepareEdit({
      operations: [{ operation: { type: 'replace_text', path: 'mod.ts', oldText: 'export function run() {\n  return "a\\b"', newText: 'x' } }],
    }).catch((error: unknown) => error)
    expect(miss).toMatchObject({ reason: 'TARGET_NOT_FOUND', details: { causes: ['backslash_escape'], candidateLine: 1 } })

    const transaction = await project.prepareEdit({
      operations: [{ operation: { type: 'replace_text', path: 'mod.ts', oldText: '  return "a\\\\b"\n}', newText: '  return "ok"\n}' } }],
    })
    expect(transaction.patches[0]?.metadata?.matchNote).toContain('第 2 行')
    await project.applyEdit({ transactionId: transaction.transactionId })
    expect(await readFile(join(root, 'mod.ts'), 'utf8')).toBe('export function run() {\n  return "ok"\n}\n')

    const read = await executeAgentProjectRead(project, {
      path: ['mod.ts'],
      range: { startLine: 50 },
    }, { rootPath: root })
    expect(read.files[0]).toMatchObject({ content: '', totalLines: 4, note: expect.stringContaining('起始行 50') })
  })
})

describe('ambiguous text anchors', () => {
  const source = [
    'function first() {',
    '  const content = read()',
    '}',
    'function second() {',
    '  const content = read()',
    '}',
    '',
  ].join('\n')

  test('lists every match line when the count assertion disagrees with occurrence', async () => {
    await writeFile(join(root, 'twice.ts'), source)
    const error = await prepareFailure({
      type: 'insert_text_at_anchor',
      path: 'twice.ts',
      anchorText: '  const content = read()',
      position: 'before',
      text: '  // note\n',
      expectedMatches: 1,
      occurrence: 1,
    })

    expect(error.reason).toBe('AMBIGUOUS_TARGET')
    expect(error.details.matches).toEqual([
      { occurrence: 1, line: 2, within: 'function first() {' },
      { occurrence: 2, line: 5, within: 'function second() {' },
    ])
    expect(error.message).toContain('第 2、5 行')
    expect(error.suggestedNextAction).toContain('expectedMatches 改为 2')
    expect(error.suggestedNextAction).toContain('occurrence')
  })

  test('lists match lines when no occurrence or replaceAll selects one', async () => {
    await writeFile(join(root, 'twice.ts'), source)
    const error = await prepareFailure({
      type: 'replace_text',
      path: 'twice.ts',
      oldText: 'const content = read()',
      newText: 'const content = load()',
    })
    expect(error.reason).toBe('AMBIGUOUS_TARGET')
    expect(error.message).toContain('第 2、5 行')
    expect(error.suggestedNextAction).toContain('occurrence（1–2')
  })

  test('lists match lines when occurrence is out of range and still edits the chosen one', async () => {
    await writeFile(join(root, 'twice.ts'), source)
    const error = await prepareFailure({
      type: 'delete_text',
      path: 'twice.ts',
      oldText: '  const content = read()\n',
      occurrence: 3,
    })
    expect(error.reason).toBe('TARGET_NOT_FOUND')
    expect(error.details.matches.map((match: { line: number }) => match.line)).toEqual([2, 5])

    const project = await createProjectKernel({ root })
    const transaction = await project.prepareEdit({
      operations: [{
        operation: {
          type: 'replace_text',
          path: 'twice.ts',
          oldText: 'const content = read()',
          newText: 'const content = load()',
          expectedMatches: 2,
          occurrence: 2,
        },
      }],
    })
    await project.applyEdit({ transactionId: transaction.transactionId })
    expect(await readFile(join(root, 'twice.ts'), 'utf8')).toBe(source.replace(/read\(\)(?![\s\S]*read\(\))/, 'load()'))
  })

  test('spells out how expectedMatches, occurrence, and replaceAll combine', () => {
    const replaceText = ProjectEditOperationSchema.options.find(
      (option) => option.shape.type.value === 'replace_text'
    )
    const shape = replaceText?.shape as Record<string, { description?: string }>
    expect(shape.expectedMatches.description).toContain('总数')
    expect(shape.expectedMatches.description).toContain('不选择修改位置')
    expect(shape.occurrence.description).toContain('第 N 个')
    expect(shape.replaceAll.description).toContain('恰好只有 1 处')
  })
})

describe('literal search hints', () => {
  function emptySearchPort(): AgentProjectKernelPort {
    return {
      search: async ({ query }: { query: string }) => ({ query, hits: [] }),
    } as unknown as AgentProjectKernelPort
  }

  test('flags | in a literal query that found nothing', async () => {
    const result = await executeAgentProjectSearch(emptySearchPort(), { query: 'alpha|beta', regex: false })
    expect(result.hits).toEqual([])
    expect(result.nextAction).toContain('query 含 |')
    expect(result.nextAction).toContain('regex: true')
  })

  test('flags regex escapes in a literal query', async () => {
    const result = await executeAgentProjectSearch(emptySearchPort(), { query: 'render\\(', regex: false })
    expect(result.nextAction).toContain('\\(')
  })

  test('stays silent for regex searches and plain literal misses', async () => {
    expect((await executeAgentProjectSearch(emptySearchPort(), { query: 'a|b', regex: true })).nextAction).toBeUndefined()
    expect((await executeAgentProjectSearch(emptySearchPort(), { query: 'plainWord' })).nextAction).toBeUndefined()
  })

  test('hints on a real literal miss and finds the alternatives once regex is on', async () => {
    await writeFile(join(root, 'code.ts'), 'const alpha = 1\nconst beta = 2\n')
    const project = await createProjectKernel({ root })
    const literal = await executeAgentProjectSearch(project, { query: 'alpha|beta' })
    expect(literal.hits).toEqual([])
    expect(literal.nextAction).toContain('query 含 |')
    const regex = await executeAgentProjectSearch(project, { query: 'alpha|beta', regex: true })
    expect(regex.hits.length).toBe(2)
    expect(regex.nextAction).toBeUndefined()
  })
})
