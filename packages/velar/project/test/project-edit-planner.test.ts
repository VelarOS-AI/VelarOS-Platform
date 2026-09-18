import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { FileStore } from '../impl/files/FileStore'
import { createProjectKernel } from '../index'
import type { ProjectEditView, ProjectPlannerResolver } from '../types/editing'
import type { ProjectContentEdit } from '../types/files'
import { normalizeProjectLineRange } from '../utils/editing/line-range'
import { completeProjectCoverage } from '../utils/editing/planner-coverage'
import { compileProjectEdit, planProjectFileEdits } from '../utils/editing/planner-index'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-new-planner-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function view(content: string, coverage = completeProjectCoverage(content)): ProjectEditView {
  return { path: 'sample.txt', revision: 'version-a', content, coverage }
}

function edit(content: string, edits: readonly ProjectContentEdit[]): string {
  return planProjectFileEdits(view(content), edits).content
}

/** 经代码面的 read 读一个 60 行文件的 range：行范围写法由代码面的入参核对把关，程序拿到的是窗口或带码的失败。 */
async function readRangeThroughSurface(range: unknown): Promise<any> {
  await writeFile(join(root, 'lines.txt'), Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n'))
  const { call } = await projectToolFixture({ root })
  return call('project', 'read', { files: [{ path: 'lines.txt', range }] })
}

describe('compact edit selector contract', () => {
  test.each([51, [51], [51, 51], [42, 45]].map((range) => [range]))('normalizes supported range %j', async (range) => {
    const expected: [number, number] = typeof range === 'number' ? [range, range] : [range[0], range[1] ?? range[0]]
    expect(normalizeProjectLineRange(range as never)).toEqual(expected)
    // 代码面的 read 收同样的写法，读到的正好是这几行。
    const [window] = (await readRangeThroughSurface(range)).files
    expect([window.lines[0][0], window.lines.at(-1)[0]]).toEqual(expected)
  })

  test.each([[], [1, 2, 3], [4, 2], 0, -1, 1.5, [1, 0], [1, 2.5], Number.MAX_SAFE_INTEGER + 1, '1', null].map((range) => [range]))('rejects malformed range %j', async (range) => {
    expect(() => normalizeProjectLineRange(range as never)).toThrow()
    // 代码面的 read 当场按入参不对拒绝。
    expect((await failureOf(readRangeThroughSurface(range))).code).toBe('INVALID_INPUT')
  })

  test('each combination has one meaning: ambiguous edits, two sources and internal operations are rejected at the code surface', async () => {
    await writeFile(join(root, 'x.txt'), 'x\n')
    const { call, mutations } = await projectToolFixture({ root })
    const [file] = (await call('project', 'read', { files: [{ path: 'x.txt' }] })).files
    const rejected = async (steps: unknown[]) => (await failureOf(call('project', 'edit', { steps }))).code
    for (const operation of [
      { op: 'replace', text: 'x' },
      { op: 'replace', range: 1, match: '', text: 'x' },
      { op: 'insert', range: 1, text: 'x' },
      { op: 'insert', at: 'start', side: 'before', text: 'x' },
      { op: 'insert', at: 'end', range: 1, text: 'x' },
      { op: 'replace', range: 1, side: 'after', text: 'x' },
    ]) expect(await rejected([{ action: 'edit', fileRef: file.fileRef, edits: [operation] }]), JSON.stringify(operation)).toBe('INVALID_INPUT')
    expect(await rejected([{ action: 'edit', sourceRef: file.fileRef, path: 'x.txt', edits: [{ op: 'replace', range: 1, text: 'x' }] }])).toBe('INVALID_INPUT')
    // 内核内部的整段替换（replace_content）从代码面够不着：它只能由规划器按读到的范围编出来。
    expect(await rejected([{ action: 'replace_content', path: 'x.txt', expectedContent: 'x\n', content: 'y\n' }])).toBe('INVALID_INPUT')
    expect(mutations).toEqual([])
    expect(await readFile(join(root, 'x.txt'), 'utf8')).toBe('x\n')
  })

  test('range and literal match independently narrow the target; overlaps count as ambiguity', () => {
    expect(edit('repeat\nrepeat\n', [{ op: 'replace', range: 2, match: 'repeat', text: 'only-second' }])).toBe('repeat\nonly-second\n')
    expect(() => edit('repeat\nrepeat', [{ op: 'replace', match: 'repeat', text: 'x' }])).toThrow('出现了 2 次')
    expect(() => edit('aaa', [{ op: 'replace', match: 'aa', text: 'x' }])).toThrow('出现了 2 次')
    expect(() => edit('MATCH', [{ op: 'replace', match: 'match', text: 'x' }])).toThrow('没有精确匹配')
  })

  test('ambiguity offers bounded distinguishing source and never writes or relaxes matching', () => {
    try { edit('const value = load() + load()', [{ op: 'replace', range: 1, match: 'load()', text: 'cached()' }]) } catch (error: any) {
      const candidates = error.details.recovery.candidates
      expect(error.reason).toBe('AMBIGUOUS_TARGET')
      expect(error.details.recovery.requiresConfirmation).toBe(true)
      expect(candidates).toHaveLength(2)
      expect(candidates[1].match).toContain('load()')
      const candidate = candidates[1]
      expect(edit('const value = load() + load()', [{ op: 'replace', range: 1, match: candidate.match, text: `${candidate.prefix  }cached()${  candidate.suffix}` }])).toBe('const value = load() + cached()')
      return
    }
    throw new Error('ambiguous match unexpectedly succeeded')
  })

  test('whitespace differences produce confirmable exact source; no tolerant write', () => {
    try { edit('const x = 1  \nreturn x\n', [{ op: 'replace', match: 'const x = 1\nreturn x', text: 'changed' }]) } catch (error: any) {
      expect(error.reason).toBe('TARGET_NOT_FOUND')
      expect(error.details.recovery.candidates[0].text).toBe('const x = 1  \nreturn x')
      expect(error.details.recovery.candidates[0].confidence).toBe('whitespace')
      return
    }
    throw new Error('whitespace mismatch unexpectedly succeeded')
  })

  test('match-only cannot see hidden text or concatenate separated windows', () => {
    const content = 'first\nhidden\nlast\n'
    const partial = view(content, [
      { startOffset: 0, endOffset: 6, startLine: 1, endLine: 1, completeLines: true },
      { startOffset: 13, endOffset: 18, startLine: 3, endLine: 3, completeLines: true },
    ])
    expect(() => planProjectFileEdits(partial, [{ op: 'replace', match: 'hidden', text: 'x' }])).toThrow('原文在未显示的第 2 行')
    expect(() => planProjectFileEdits(partial, [{ op: 'replace', match: 'first\nlast', text: 'x' }])).toThrow('没有精确匹配')
    expect(() => planProjectFileEdits(partial, [{ op: 'replace', range: [1, 3], match: 'first', text: 'x' }])).toThrow('实际显示')
  })

  test('fragment authorizes only shown characters and cannot authorize whole-line edits', () => {
    const fragment = view('left target right', [{ startOffset: 5, endOffset: 11, startLine: 1, endLine: 1, completeLines: false }])
    expect(planProjectFileEdits(fragment, [{ op: 'replace', range: 1, match: 'target', text: 'changed' }]).content).toBe('left changed right')
    expect(() => planProjectFileEdits(fragment, [{ op: 'replace', range: 1, text: 'changed' }])).toThrow('实际显示')
    expect(() => planProjectFileEdits(fragment, [{ op: 'replace', match: 'target right', text: 'changed' }])).toThrow('原文在未显示的第 1 行')
    expect(() => planProjectFileEdits(fragment, [{ op: 'insert', at: 'end', text: 'new' }])).toThrow('实际显示')
  })

  test('separated fragments on one line never offer an ambiguous unchanged match as a correction', () => {
    const content = 'left hit unseen right hit'
    const partial = view(content, [
      { startOffset: 0, endOffset: 8, startLine: 1, endLine: 1, completeLines: false },
      { startOffset: 16, endOffset: 25, startLine: 1, endLine: 1, completeLines: false },
    ])
    try { planProjectFileEdits(partial, [{ op: 'replace', match: 'hit', text: 'new' }]) } catch (error: any) {
      expect(error.reason).toBe('AMBIGUOUS_TARGET')
      const candidate = error.details.recovery.candidates[1]
      expect(candidate.match).not.toBe('hit')
      expect(planProjectFileEdits(partial, [{ op: 'replace', range: candidate.range, match: candidate.match, text: `${candidate.prefix  }new${  candidate.suffix}` }]).content).toBe('left hit unseen right new')
      return
    }
    throw new Error('repeated fragment unexpectedly accepted')
  })

  test('very long repeated lines produce bounded diagnostics without guessing a target', () => {
    try { edit('x '.repeat(100_000), [{ op: 'replace', range: 1, match: 'x', text: 'y' }]) } catch (error: any) {
      expect(error.reason).toBe('AMBIGUOUS_TARGET')
      expect(error.details.matches).toBe(100_000)
      expect(error.details.recovery.candidates).toHaveLength(8)
      expect(JSON.stringify(error.details).length).toBeLessThan(16_000)
      return
    }
    throw new Error('ambiguous long line unexpectedly accepted')
  })

  test('zero-hit guidance says whether to move the range, read more, or recopy the source', () => {
    const failure = (content: string, edits: ProjectContentEdit[], coverage?: Parameters<typeof view>[1]) => {
      try { planProjectFileEdits(coverage ? view(content, coverage) : view(content), edits) } catch (error: any) { return error }
      throw new Error('edit unexpectedly accepted')
    }
    const outside = failure('one\ntwo\nthree\n', [{ op: 'replace', range: 1, match: 'three', text: 'x' }])
    expect(outside.details.elsewhere).toEqual([{ range: [3, 3], visible: true }])
    expect(outside.suggestedNextAction).toContain('range')
    const hidden = failure('one\ntwo\nthree\n', [{ op: 'replace', match: 'three', text: 'x' }], [{ startOffset: 0, endOffset: 4, startLine: 1, endLine: 1, completeLines: true }])
    expect(hidden.details.elsewhere).toEqual([{ range: [3, 3], visible: false }])
    expect(hidden.suggestedNextAction).toContain('先 read 这些行')
    const absent = failure('one\ntwo\n', [{ op: 'replace', match: 'zzz', text: 'x' }])
    expect(absent.message).toContain('也没有相近的原文')
    expect(absent.details.elsewhere).toBeUndefined()
    expect(absent.suggestedNextAction).not.toContain('核对候选')
  })

  test('matches cannot extend beyond an explicit range', () => {
    expect(() => edit('one\ntwo\n', [{ op: 'replace', range: 1, match: 'one\ntwo', text: 'x' }])).toThrow('不在所选 range 内，它出现在第 1–2 行')
    expect(() => edit('one\n', [{ op: 'replace', range: 3, text: 'x' }])).toThrow('第 3 行超出了文件的行数（1 行）')
  })
})

describe('fixed coordinates and exact text preservation', () => {
  test('earlier insertions do not move later selectors; same-position insertion order is deterministic', () => {
    expect(edit('a\nb\nc', [
      { op: 'insert', range: 1, side: 'before', text: 'first\nsecond' },
      { op: 'replace', range: 3, text: 'last' },
      { op: 'insert', range: 1, side: 'before', text: 'third' },
    ])).toBe('first\nsecond\nthird\na\nb\nlast')
    expect(edit('a', [{ op: 'insert', at: 'end', text: 'b' }, { op: 'insert', at: 'end', text: 'c' }])).toBe('a\nb\nc')
  })

  test('overlapping replacements and embedded insertion reject the entire plan', () => {
    expect(() => edit('abcdef', [{ op: 'replace', match: 'abcd', text: 'x' }, { op: 'replace', match: 'cdef', text: 'y' }])).toThrow('重叠')
    expect(() => edit('abcdef', [{ op: 'replace', match: 'abcd', text: 'x' }, { op: 'insert', match: 'bc', side: 'after', text: 'y' }])).toThrow('替换内部')
    expect(edit('abcdef', [{ op: 'replace', match: 'abcd', text: 'x' }, { op: 'insert', match: 'abcd', side: 'after', text: 'y' }])).toBe('xyef')
  })

  test.each([
    ['', [{ op: 'insert', at: 'start', text: 'hello' }], 'hello'],
    ['a\nb\n', [{ op: 'replace', range: 2, text: 'x\ny' }], 'a\nx\ny\n'],
    ['a\nb\n', [{ op: 'replace', range: 2, text: 'x\n' }], 'a\nx\n'],
    ['a\nb', [{ op: 'replace', range: 2, text: '' }], 'a\n'],
    ['a\nb', [{ op: 'replace', range: 2, text: 'x' }], 'a\nx'],
    ['a\nb', [{ op: 'replace', range: 2, text: 'x\n' }], 'a\nx\n'],
    // 末尾换行之后那条空行被整行替换时，保留原文件的末尾换行（与在该处插入一致）。
    ['a\n', [{ op: 'replace', range: 2, text: 'x' }], 'a\nx\n'],
    ['a\n', [{ op: 'insert', range: 2, side: 'before', text: 'x' }], 'a\nx\n'],
    ['a', [{ op: 'insert', at: 'start', text: 'x\n' }], 'x\na'],
    ['a\n', [{ op: 'insert', at: 'end', text: 'x' }], 'a\nx\n'],
    ['a', [{ op: 'insert', match: 'a', side: 'after', text: 'x' }], 'ax'],
    ['a\r\nb\nc\r\n', [{ op: 'replace', range: 2, text: 'x\ny' }], 'a\r\nx\ny\nc\r\n'],
    ['a\r\nb\r\nc', [{ op: 'replace', range: 2, match: 'b\n', text: 'x\n' }], 'a\r\nx\r\nc'],
  ])('handles empty/EOF/EOL boundaries: %j', (content, operations, expected) => {
    expect(edit(content as string, operations as ProjectContentEdit[])).toBe(expected)
  })

  test('mixed physical newlines normalize for matching without changing untouched bytes', () => {
    expect(edit('a\r\nb\nc\r\n', [{ op: 'replace', match: 'a\nb\nc', text: 'x\ny' }])).toBe('x\r\ny\r\n')
    expect(edit('a\r\nb\nc\r\n', [{ op: 'replace', range: 2, match: 'b', text: '🙂\\n\\\\' }])).toBe('a\r\n🙂\\n\\\\\nc\r\n')
  })

  test('Unicode is not re-decoded and malformed surrogate output rejects', () => {
    expect(edit('标题🙂 = "\\u4e00"', [{ op: 'replace', match: '🙂', text: '🧪\\n' }])).toBe('标题🧪\\n = "\\u4e00"')
    expect(() => edit('a', [{ op: 'replace', range: 1, text: '\uD83D' }])).toThrow('不完整')
  })

  test('1000 replacements use original coordinates in a large file without replaying old source', () => {
    const original = Array.from({ length: 50_000 }, (_, index) => `row ${index + 1}`).join('\n')
    const operations = Array.from({ length: 1000 }, (_, index): ProjectContentEdit => ({ op: 'replace', range: (index + 1) * 40, text: `changed ${index}` })).reverse()
    const actual = edit(original, operations).split('\n')
    expect(actual).toHaveLength(50_000)
    for (let index = 0; index < 1000; index += 1) expect(actual[(index + 1) * 40 - 1]).toBe(`changed ${index}`)
    expect(actual[49_999]).toBe('row 50000')
  })
})

async function kernelFixture(files: Record<string, string>, revisionStrategy: 'metadata' | 'content' = 'content') {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content)
    await utimes(join(root, path), 10, 10)
  }
  const project = await createProjectKernel({ root, corePolicy: { revisionStrategy } })
  const views = new Map<string, ProjectEditView>()
  for (const path of Object.keys(files)) {
    const result = await project.read({ path })
    views.set(path, { ...view(files[path]), path, revision: result.snapshot.revision })
  }
  const resolver: ProjectPlannerResolver = {
    resolveFileRef: async (ref) => { const resolved = views.get(ref); if (!resolved) throw new Error('missing ref'); return resolved },
    readPath: async (path) => { const result = await project.read({ path }); return result.snapshot },
    readText: async () => { throw new Error('recode is not part of this fixture') },
    listPaths: async () => { throw new Error('recode is not part of this fixture') },
  }
  return { project, resolver, views }
}

describe('compiled plans on the real transaction engine', () => {
  test('mixed create, edit, move, overwrite and delete prepare once, apply atomically and undo', async () => {
    const { project, resolver } = await kernelFixture({ 'a.txt': 'alpha\n', 'obsolete.txt': 'old\n' })
    const plan = await compileProjectEdit({ steps: [
      { action: 'create', path: 'new.txt', text: 'seed\n' }, { action: 'move', fileRef: 'a.txt', to: 'moved.txt' },
      { action: 'edit', path: 'new.txt', edits: [{ op: 'replace', range: 1, text: 'grown' }] }, { action: 'edit', sourceRef: 'a.txt', edits: [{ op: 'replace', range: 1, match: 'alpha', text: 'beta' }] },
      { action: 'overwrite', sourceRef: 'a.txt', text: 'final\r\n' }, { action: 'delete', fileRef: 'obsolete.txt' }, { action: 'move', path: 'new.txt', to: 'final.txt' },
      { action: 'edit', path: 'final.txt', edits: [{ op: 'insert', at: 'end', text: 'done' }] },
    ] }, resolver)
    const tx = await project.prepareEdit(plan)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('final\n')
    expect(await readFile(join(root, 'final.txt'), 'utf8')).toBe('grown\ndone\n')
    await expect(readFile(join(root, 'a.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'obsolete.txt'))).rejects.toThrow()
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'obsolete.txt'), 'utf8')).toBe('old\n')
    await expect(readFile(join(root, 'final.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
  })

  test('a late failing step leaves every disk file untouched', async () => {
    const { resolver } = await kernelFixture({ 'a.txt': 'alpha\n' })
    await expect(compileProjectEdit({ steps: [
      { action: 'create', path: 'new.txt', text: 'new' },
      { action: 'edit', fileRef: 'a.txt', edits: [{ op: 'replace', match: 'missing', text: 'bad' }] },
      // 一步一个目标：错在哪一步、哪一处编辑，details 就只有 stepIndex 和 editIndex。
    ] }, resolver)).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND', details: { stepIndex: 1, editIndex: 0 } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
  })

  test('future views retain actual coverage and follow only explicit sourceRef', async () => {
    const { resolver, views } = await kernelFixture({ 'a.txt': 'visible\nhidden\n' })
    views.set('a.txt', { ...views.get('a.txt')!, coverage: [{ startOffset: 0, endOffset: 8, startLine: 1, endLine: 1, completeLines: true }] })
    const first = { action: 'edit' as const, fileRef: 'a.txt', edits: [{ op: 'replace' as const, range: 1, text: 'new\nvisible' }] }
    await expect(compileProjectEdit({ steps: [first, { action: 'edit', sourceRef: 'a.txt', edits: [{ op: 'replace', range: 3, text: 'bad' }] }] }, resolver)).rejects.toMatchObject({ reason: 'SCOPE_VIOLATION' })
    // 前面的步骤动过这个文件：这是入参该换成 sourceRef，不是版本过期。
    await expect(compileProjectEdit({ steps: [first, { action: 'edit', fileRef: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'bad' }] }] }, resolver)).rejects.toMatchObject({ reason: 'INVALID_INPUT', suggestedNextAction: expect.stringContaining('sourceRef') })
    const valid = await compileProjectEdit({ steps: [first, { action: 'edit', sourceRef: 'a.txt', edits: [{ op: 'replace', range: 2, text: 'known' }] }] }, resolver)
    expect(valid.operations.at(-1)?.operation).toMatchObject({ content: 'new\nknown\nhidden\n' })
  })

  test('file operations reject existing destinations, unintended path sources and stale repeat refs', async () => {
    const { resolver } = await kernelFixture({ 'a.txt': 'a', 'b.txt': 'b' })
    await expect(compileProjectEdit({ steps: [{ action: 'create', path: './a.txt', text: 'bad' }] }, resolver)).rejects.toMatchObject({ reason: 'TARGET_EXISTS', details: { path: 'a.txt' } })
    await expect(compileProjectEdit({ steps: [{ action: 'move', fileRef: 'a.txt', to: 'b.txt' }] }, resolver)).rejects.toMatchObject({ reason: 'TARGET_EXISTS', details: { path: 'b.txt' } })
    await expect(compileProjectEdit({ steps: [{ action: 'edit', path: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'bad' }] }] }, resolver)).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND' })
    await expect(compileProjectEdit({ steps: [{ action: 'overwrite', fileRef: 'a.txt', text: 'new' }, { action: 'delete', fileRef: 'a.txt' }] }, resolver)).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
  })

  test.each(['before-prepare', 'before-apply'])('content CAS rejects same metadata external changes %s', async (timing) => {
    const { project, resolver, views } = await kernelFixture({ 'a.txt': 'old\n' }, 'metadata')
    const plan = await compileProjectEdit({ steps: [{ action: 'edit', fileRef: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'our' }] }] }, resolver)
    const tx = timing === 'before-apply' ? await project.prepareEdit(plan) : undefined
    await writeFile(join(root, 'a.txt'), 'ext\n')
    await utimes(join(root, 'a.txt'), 10, 10)
    expect((await project.read({ path: 'a.txt' })).snapshot.revision).toBe(views.get('a.txt')!.revision)
    if (tx) await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    else await expect(project.prepareEdit(plan)).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ext\n')
  })

  test('file guard survives prepare and protects a delete after same metadata change', async () => {
    const { project, resolver } = await kernelFixture({ 'a.txt': 'old\n' }, 'metadata')
    const plan = await compileProjectEdit({ steps: [{ action: 'delete', fileRef: 'a.txt' }] }, resolver)
    const tx = await project.prepareEdit(plan)
    expect(tx.patches[0].metadata?.mode).toBe('guard')
    await writeFile(join(root, 'a.txt'), 'ext\n')
    await utimes(join(root, 'a.txt'), 10, 10)
    await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ext\n')
  })

  test('an injected failure after a mixed-plan write rolls back all paths', async () => {
    const { project, resolver } = await kernelFixture({ 'a.txt': 'old\n' })
    const plan = await compileProjectEdit({ steps: [
      { action: 'move', fileRef: 'a.txt', to: 'moved.txt' }, { action: 'create', path: 'created.txt', text: 'new' },
    ] }, resolver)
    const tx = await project.prepareEdit(plan)
    const originalWrite = FileStore.prototype.write
    let fail = true
    const hook = spyOn(FileStore.prototype, 'write').mockImplementation(async function(this: FileStore, ...args: Parameters<typeof originalWrite>) {
      const result = await originalWrite.apply(this, args)
      if (args[0] === 'created.txt' && fail) { fail = false; throw new Error('mixed write fault') }
      return result
    })
    try {
      await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toThrow('mixed write fault')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old\n')
      await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
      await expect(readFile(join(root, 'created.txt'))).rejects.toThrow()
    } finally { hook.mockRestore() }
  })

  test('compiled edits preserve UTF-16 bytes through write and rollback', async () => {
    const original = Buffer.from('\uFEFF标题🙂\r\n原文\r\n', 'utf16le')
    await writeFile(join(root, 'utf16.txt'), original)
    const project = await createProjectKernel({ root })
    const read = await project.read({ path: 'utf16.txt' })
    const resolver: ProjectPlannerResolver = {
      resolveFileRef: async () => ({ ...view(read.snapshot.content!), path: 'utf16.txt', revision: read.snapshot.revision }),
      readPath: async (path) => (await project.read({ path })).snapshot,
      readText: async () => { throw new Error('recode is not part of this fixture') },
      listPaths: async () => { throw new Error('recode is not part of this fixture') },
    }
    const tx = await project.prepareEdit(await compileProjectEdit({ steps: [{ action: 'edit', fileRef: 'v', edits: [{ op: 'replace', range: 2, text: '修改🧪' }] }] }, resolver))
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'utf16.txt'))).toEqual(Buffer.from('\uFEFF标题🙂\r\n修改🧪\r\n', 'utf16le'))
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'utf16.txt'))).toEqual(original)
  })

  test('large compiled plans persist compact intent metadata and survive restart apply and rollback', async () => {
    const content = Array.from({ length: 20_000 }, (_, index) => `entry ${index + 1}: immutable original source`).join('\n')
    await writeFile(join(root, 'large.txt'), content)
    const transactionStatePath = join(root, '.state', 'transactions.json')
    const project = await createProjectKernel({ root, transactionStatePath })
    const read = await project.read({ path: 'large.txt', maxChars: content.length + 1 })
    const originalView = { ...view(content), path: 'large.txt', revision: read.snapshot.revision }
    const resolver: ProjectPlannerResolver = {
      resolveFileRef: async () => originalView,
      readPath: async (path) => (await project.read({ path })).snapshot,
      readText: async () => { throw new Error('recode is not part of this fixture') },
      listPaths: async () => { throw new Error('recode is not part of this fixture') },
    }
    const plan = await compileProjectEdit({ steps: [{ action: 'edit', fileRef: 'v', edits: [{ op: 'replace', range: 10_000, text: 'changed and verified' }] }] }, resolver)
    const tx = await project.prepareEdit(plan)
    expect(tx.patches[0].metadata?.intentOperation).toBeUndefined()
    expect(tx.patches[0].metadata?.intentOperationType).toBe('replace_content')
    expect(JSON.stringify(tx.patches[0].metadata).length).toBeLessThan(1024)
    expect(JSON.stringify(tx).length).toBeLessThan(content.length * 3.5)

    const restarted = await createProjectKernel({ root, transactionStatePath })
    expect(restarted.getTransaction(tx.transactionId)?.patches[0].oldContent).toBe(content)
    await restarted.applyEdit({ transactionId: tx.transactionId })
    expect((await readFile(join(root, 'large.txt'), 'utf8')).split('\n')[9999]).toBe('changed and verified')
    const afterApply = await createProjectKernel({ root, transactionStatePath })
    await afterApply.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'large.txt'), 'utf8')).toBe(content)
  })

  test('move chains preserve file identity even when its old path is reused', async () => {
    const { project, resolver, views } = await kernelFixture({ 'a.txt': 'source\n' })
    views.set('second-view', views.get('a.txt')!)
    const plan = await compileProjectEdit({ steps: [
      { action: 'move', fileRef: 'a.txt', to: 'b.txt' }, { action: 'create', path: 'a.txt', text: 'replacement\n' }, { action: 'move', sourceRef: 'second-view', to: 'c.txt' },
      { action: 'edit', sourceRef: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'same identity' }] }, { action: 'edit', path: 'a.txt', edits: [{ op: 'insert', at: 'end', text: 'new identity' }] },
    ] }, resolver)
    const tx = await project.prepareEdit(plan)
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('replacement\nnew identity\n')
    expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('same identity\n')
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow()
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('source\n')
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'c.txt'))).rejects.toThrow()
  })
})
