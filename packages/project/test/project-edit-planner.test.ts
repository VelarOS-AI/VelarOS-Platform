import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { ProjectChangeSchema } from '../src/agent/contracts/change'
import { ProjectEditSchema } from '../src/agent/contracts/edit'
import { ProjectFileSchema } from '../src/agent/contracts/file'
import { ProjectLineRangeSchema } from '../src/agent/contracts/range'
import { completeProjectCoverage } from '../src/editing/planner/coverage'
import { compileProjectChange, compileProjectEdit, compileProjectFile, planProjectFileEdits } from '../src/editing/planner/index'
import { normalizeProjectLineRange } from '../src/editing/selectors/range'
import type { ProjectContentEdit, ProjectEditView, ProjectPlannerResolver } from '../src/editing/types'
import { ProjectModelEditSchema } from '../src/edits/schema'
import { FileStore } from '../src/files/file-store'
import { createProjectKernel } from '../src/index'

function view(content: string, coverage = completeProjectCoverage(content)): ProjectEditView {
  return { path: 'sample.txt', revision: 'version-a', content, coverage }
}

function edit(content: string, edits: readonly ProjectContentEdit[]): string {
  return planProjectFileEdits(view(content), edits).content
}

describe('compact edit selector contract', () => {
  test.each([51, [51], [51, 51], [42, 45]].map((range) => [range]))('normalizes supported range %j', (range) => {
    expect(ProjectLineRangeSchema.safeParse(range).success).toBe(true)
    expect(normalizeProjectLineRange(range as never)).toEqual(typeof range === 'number' ? [range, range] : [range[0], range[1] ?? range[0]])
  })

  test.each([[], [1, 2, 3], [4, 2], 0, -1, 1.5, [1, 0], [1, 2.5], Number.MAX_SAFE_INTEGER + 1, '1', null].map((range) => [range]))('rejects malformed range %j', (range) => {
    expect(ProjectLineRangeSchema.safeParse(range).success).toBe(false)
    expect(() => normalizeProjectLineRange(range as never)).toThrow()
  })

  test('schemas have one meaning per combination and retain object roots for reuse', () => {
    expect(ProjectEditSchema.type).toBe('object')
    expect(ProjectFileSchema.type).toBe('object')
    expect(ProjectChangeSchema.type).toBe('object')
    for (const operation of [
      { op: 'replace', text: 'x' },
      { op: 'replace', range: 1, match: '', text: 'x' },
      { op: 'insert', range: 1, text: 'x' },
      { op: 'insert', at: 'start', side: 'before', text: 'x' },
      { op: 'insert', at: 'end', range: 1, text: 'x' },
      { op: 'replace', range: 1, side: 'after', text: 'x' },
    ]) expect(ProjectEditSchema.safeParse({ files: [{ fileRef: 'v', edits: [operation] }] }).success).toBe(false)
    expect(ProjectChangeSchema.safeParse({ action: 'apply', steps: [{ tool: 'edit', files: [{ sourceRef: 'v', path: 'x', edits: [{ op: 'replace', range: 1, text: 'x' }] }] }] }).success).toBe(false)
    expect(ProjectChangeSchema.safeParse({ action: 'inspect', steps: [], changeRef: 'v' }).success).toBe(false)
    expect(ProjectModelEditSchema.safeParse({ edits: [{ type: 'replace_content', path: 'x', expectedContent: 'a', content: 'b' }] }).success).toBe(false)
  })

  test('range and literal match independently narrow the target; overlaps count as ambiguity', () => {
    expect(edit('repeat\nrepeat\n', [{ op: 'replace', range: 2, match: 'repeat', text: 'only-second' }])).toBe('repeat\nonly-second\n')
    expect(() => edit('repeat\nrepeat', [{ op: 'replace', match: 'repeat', text: 'x' }])).toThrow('2 个匹配')
    expect(() => edit('aaa', [{ op: 'replace', match: 'aa', text: 'x' }])).toThrow('2 个匹配')
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
    expect(() => planProjectFileEdits(partial, [{ op: 'replace', match: 'hidden', text: 'x' }])).toThrow('没有精确匹配')
    expect(() => planProjectFileEdits(partial, [{ op: 'replace', match: 'first\nlast', text: 'x' }])).toThrow('没有精确匹配')
    expect(() => planProjectFileEdits(partial, [{ op: 'replace', range: [1, 3], match: 'first', text: 'x' }])).toThrow('实际显示')
  })

  test('fragment authorizes only shown characters and cannot authorize whole-line edits', () => {
    const fragment = view('left target right', [{ startOffset: 5, endOffset: 11, startLine: 1, endLine: 1, completeLines: false }])
    expect(planProjectFileEdits(fragment, [{ op: 'replace', range: 1, match: 'target', text: 'changed' }]).content).toBe('left changed right')
    expect(() => planProjectFileEdits(fragment, [{ op: 'replace', range: 1, text: 'changed' }])).toThrow('实际显示')
    expect(() => planProjectFileEdits(fragment, [{ op: 'replace', match: 'target right', text: 'changed' }])).toThrow('没有精确匹配')
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

  test('matches cannot extend beyond an explicit range', () => {
    expect(() => edit('one\ntwo\n', [{ op: 'replace', range: 1, match: 'one\ntwo', text: 'x' }])).toThrow('没有精确匹配')
    expect(() => edit('one\n', [{ op: 'replace', range: 3, text: 'x' }])).toThrow('超出文件')
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
    ['a\n', [{ op: 'replace', range: 2, text: 'x' }], 'a\nx'],
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

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-new-planner-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

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
  }
  return { project, resolver, views }
}

describe('compiled plans on the real transaction engine', () => {
  test('mixed create, edit, move, overwrite and delete prepare once, apply atomically and undo', async () => {
    const { project, resolver } = await kernelFixture({ 'a.txt': 'alpha\n', 'obsolete.txt': 'old\n' })
    const plan = await compileProjectChange({ action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'create', path: 'new.txt', text: 'seed\n' }, { op: 'move', fileRef: 'a.txt', to: 'moved.txt' }] },
      { tool: 'edit', files: [{ path: 'new.txt', edits: [{ op: 'replace', range: 1, text: 'grown' }] }, { sourceRef: 'a.txt', edits: [{ op: 'replace', range: 1, match: 'alpha', text: 'beta' }] }] },
      { tool: 'file', actions: [{ op: 'overwrite', sourceRef: 'a.txt', text: 'final\r\n' }, { op: 'delete', fileRef: 'obsolete.txt' }, { op: 'move', path: 'new.txt', to: 'final.txt' }] },
      { tool: 'edit', files: [{ path: 'final.txt', edits: [{ op: 'insert', at: 'end', text: 'done' }] }] },
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
    await expect(compileProjectChange({ action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'create', path: 'new.txt', text: 'new' }] },
      { tool: 'edit', files: [{ fileRef: 'a.txt', edits: [{ op: 'replace', match: 'missing', text: 'bad' }] }] },
    ] }, resolver)).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND', details: { stepIndex: 1, fileIndex: 0, editIndex: 0 } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
  })

  test('future views retain actual coverage and follow only explicit sourceRef', async () => {
    const { resolver, views } = await kernelFixture({ 'a.txt': 'visible\nhidden\n' })
    views.set('a.txt', { ...views.get('a.txt')!, coverage: [{ startOffset: 0, endOffset: 8, startLine: 1, endLine: 1, completeLines: true }] })
    const first = { tool: 'edit' as const, files: [{ fileRef: 'a.txt', edits: [{ op: 'replace' as const, range: 1, text: 'new\nvisible' }] }] }
    await expect(compileProjectChange({ action: 'apply', steps: [first, { tool: 'edit', files: [{ sourceRef: 'a.txt', edits: [{ op: 'replace', range: 3, text: 'bad' }] }] }] }, resolver)).rejects.toMatchObject({ reason: 'SCOPE_VIOLATION' })
    await expect(compileProjectChange({ action: 'apply', steps: [first, { tool: 'edit', files: [{ fileRef: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'bad' }] }] }] }, resolver)).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    const valid = await compileProjectChange({ action: 'apply', steps: [first, { tool: 'edit', files: [{ sourceRef: 'a.txt', edits: [{ op: 'replace', range: 2, text: 'known' }] }] }] }, resolver)
    expect(valid.operations.at(-1)?.operation).toMatchObject({ content: 'new\nknown\nhidden\n' })
  })

  test('file operations reject existing destinations, unintended path sources and stale repeat refs', async () => {
    const { resolver } = await kernelFixture({ 'a.txt': 'a', 'b.txt': 'b' })
    await expect(compileProjectFile({ actions: [{ op: 'create', path: './a.txt', text: 'bad' }] }, resolver)).rejects.toMatchObject({ reason: 'CONFLICT_WITH_EXTERNAL_EDIT' })
    await expect(compileProjectFile({ actions: [{ op: 'move', fileRef: 'a.txt', to: 'b.txt' }] }, resolver)).rejects.toMatchObject({ reason: 'CONFLICT_WITH_EXTERNAL_EDIT' })
    await expect(compileProjectChange({ action: 'apply', steps: [{ tool: 'edit', files: [{ path: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'bad' }] }] }] }, resolver)).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND' })
    await expect(compileProjectFile({ actions: [{ op: 'overwrite', fileRef: 'a.txt', text: 'new' }, { op: 'delete', fileRef: 'a.txt' }] }, resolver)).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
  })

  test.each(['before-prepare', 'before-apply'])('content CAS rejects same metadata external changes %s', async (timing) => {
    const { project, resolver, views } = await kernelFixture({ 'a.txt': 'old\n' }, 'metadata')
    const plan = await compileProjectEdit({ files: [{ fileRef: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'our' }] }] }, resolver)
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
    const plan = await compileProjectFile({ actions: [{ op: 'delete', fileRef: 'a.txt' }] }, resolver)
    const tx = await project.prepareEdit(plan)
    expect(tx.patches[0].metadata?.mode).toBe('guard')
    await writeFile(join(root, 'a.txt'), 'ext\n')
    await utimes(join(root, 'a.txt'), 10, 10)
    await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ext\n')
  })

  test('an injected failure after a mixed-plan write rolls back all paths', async () => {
    const { project, resolver } = await kernelFixture({ 'a.txt': 'old\n' })
    const plan = await compileProjectChange({ action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'move', fileRef: 'a.txt', to: 'moved.txt' }, { op: 'create', path: 'created.txt', text: 'new' }] },
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
    }
    const tx = await project.prepareEdit(await compileProjectEdit({ files: [{ fileRef: 'v', edits: [{ op: 'replace', range: 2, text: '修改🧪' }] }] }, resolver))
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
    }
    const plan = await compileProjectEdit({ files: [{ fileRef: 'v', edits: [{ op: 'replace', range: 10_000, text: 'changed and verified' }] }] }, resolver)
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
    const plan = await compileProjectChange({ action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'move', fileRef: 'a.txt', to: 'b.txt' }, { op: 'create', path: 'a.txt', text: 'replacement\n' }, { op: 'move', sourceRef: 'second-view', to: 'c.txt' }] },
      { tool: 'edit', files: [{ sourceRef: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'same identity' }] }, { path: 'a.txt', edits: [{ op: 'insert', at: 'end', text: 'new identity' }] }] },
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
