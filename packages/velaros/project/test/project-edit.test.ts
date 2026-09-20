/**
 * `velaros:project` 的改的一侧：edit 把几步合成一个事务、回执窗口、inspect 与 undo、版本过期的恢复、编码与换行的保留。
 * 一律经 `call('project', …)` 走真的代码面端口；失败只看程序拿得到的 error.code 与 error.message。
 */

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { textCodec } from '@velaros-ai/core/text-files'

import { typescriptPlugin } from '../index'
import { completeProjectCoverage } from '../utils/editing/planner-coverage'
import { suggestProjectEditLocations } from '../utils/editing/stale-location'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-edit-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

type Fixture = Awaited<ReturnType<typeof projectToolFixture>>

/** 读一个文件，交回它的第一个窗口。 */
async function readOne(call: Fixture['call'], path: string, range?: unknown) {
  return (await call('project', 'read', { files: [range === undefined ? { path } : { path, range }] })).files[0]
}

/** 提交一次 edit。 */
function edit(call: Fixture['call'], steps: unknown[]) {
  return call('project', 'edit', { steps })
}

/** 凭一个 fileRef 改一处。 */
function editLine(call: Fixture['call'], fileRef: string, range: unknown, text: string) {
  return edit(call, [{ action: 'edit', fileRef, edits: [{ op: 'replace', range, text }] }])
}

/** 磁盘上的正文。 */
const disk = (path: string) => readFile(join(root, path), 'utf8')

describe('edit：几步合成一个事务', () => {
  test('各种选位置的写法都按同一份原文执行，回执给新的 fileRef 接着改，旧的作废', async () => {
    await writeFile(join(root, 'a.txt'), 'header\nold\nvalue oldCall()\ntarget\nend\n')
    const { call } = await projectToolFixture({ root })
    const original = await readOne(call, 'a.txt')
    const result = await edit(call, [{ action: 'edit', fileRef: original.fileRef, edits: [
      { op: 'insert', at: 'start', text: 'start' },
      { op: 'replace', range: [2], text: 'new\nextra' },
      { op: 'replace', range: 3, match: 'oldCall()', text: 'newCall()' },
      { op: 'insert', range: [4, 4], side: 'before', text: 'before' },
      { op: 'insert', match: 'target', side: 'after', text: '!' },
      { op: 'insert', at: 'end', text: 'finish' },
    ] }])
    expect(result.changed).toBe(true)
    expect(result.changeRef).toStartWith('change:')
    expect(await disk('a.txt')).toBe('start\nheader\nnew\nextra\nvalue newCall()\nbefore\ntarget!\nend\nfinish\n')
    const current = result.files.find((window: { path: string; fileRef?: string }) => window.path === 'a.txt' && window.fileRef)
    expect(current.fileRef).toStartWith('view:')
    expect(current.fileRef).not.toBe(original.fileRef)
    expect(current.revision).toBe(result.newRevisions['a.txt'])
    await edit(call, [{ action: 'edit', fileRef: current.fileRef, edits: [{ op: 'replace', match: 'target!', text: 'confirmed' }] }])
    expect(await disk('a.txt')).toContain('confirmed\n')
    expect((await failureOf(editLine(call, original.fileRef, 2, 'stale'))).code).toBe('BASE_REVISION_MISMATCH')
  })

  test('五万行文件两段窄窗口里的一千处改动：一个事务提交、一次撤销', async () => {
    const content = Array.from({ length: 50_000 }, (_, index) => `row ${index + 1}`).join('\n')
    await writeFile(join(root, 'large.txt'), content)
    const { call, kernel } = await projectToolFixture({ root })
    const first = await readOne(call, 'large.txt', [1, 500])
    const last = await readOne(call, 'large.txt', [49_501, 50_000])
    expect(first.fileRef).not.toBe(last.fileRef)
    const changed = await edit(call, [
      { action: 'edit', fileRef: first.fileRef, edits: Array.from({ length: 500 }, (_, index) => ({ op: 'replace', range: index + 1, text: `changed ${index + 1}` })) },
      // 同一个文件的第二段：前一步已经改过它，按 sourceRef 跟随改完后的内容。
      { action: 'edit', sourceRef: last.fileRef, edits: Array.from({ length: 500 }, (_, index) => ({ op: 'replace', range: index + 49_501, text: `changed ${index + 49_501}` })) },
    ])
    // 一步一个补丁，一次事务一起提交：两步都落在 large.txt 上。
    expect(kernel.getTransaction(changed.transactionId)?.patches.map((patch) => patch.path)).toEqual(['large.txt', 'large.txt'])
    const actual = (await disk('large.txt')).split('\n')
    expect(actual).toHaveLength(50_000)
    for (let index = 0; index < 500; index += 1) {
      expect(actual[index]).toBe(`changed ${index + 1}`)
      expect(actual[index + 49_500]).toBe(`changed ${index + 49_501}`)
    }
    expect(actual[501]).toBe('row 502')
    // 回执窗口都在新版本上，带着新的 fileRef。
    expect(changed.files.length).toBeGreaterThan(0)
    for (const window of changed.files) expect(window).toMatchObject({ path: 'large.txt', revision: changed.newRevisions['large.txt'], fileRef: expect.stringMatching(/^view:/) })
    await call('project', 'undo', { changeRef: changed.changeRef })
    expect(await disk('large.txt')).toBe(content)
  })

  test('借别的 fileRef 的覆盖、前一步动过的文件还写 fileRef：整批拒绝，一个文件都不写', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call } = await projectToolFixture({ root })
    const first = await readOne(call, 'a.txt', 1)
    const last = await readOne(call, 'a.txt', 3)
    const borrowed = await failureOf(edit(call, [
      { action: 'edit', fileRef: first.fileRef, edits: [{ op: 'replace', match: 'third', text: 'bad' }] },
      { action: 'edit', sourceRef: last.fileRef, edits: [{ op: 'replace', match: 'third', text: 'last' }] },
    ]))
    expect(borrowed.code).toBe('TARGET_NOT_FOUND')
    expect(borrowed.message).toStartWith('steps[0]')
    const whole = await readOne(call, 'a.txt')
    // 前一步动过这个文件，第二步还写 fileRef：点名改成 sourceRef 或者合并到同一步。
    const repeated = await failureOf(edit(call, [
      { action: 'edit', fileRef: first.fileRef, edits: [{ op: 'replace', range: 1, text: 'one' }] },
      { action: 'edit', fileRef: whole.fileRef, edits: [{ op: 'replace', range: [1, 2], text: 'two' }] },
    ]))
    expect(repeated.code).toBe('INVALID_INPUT')
    expect(repeated.message).toStartWith('steps[1]')
    expect(repeated.message).toContain('sourceRef')
    expect(await disk('a.txt')).toBe('first\nsecond\nthird\n')
  })

  test('新建、整份替换、移动、删除都有回执；inspect 看得到前后版本，undo 恢复最后的那个文件', async () => {
    const { call } = await projectToolFixture({ root })
    const created = await edit(call, [{ action: 'create', path: 'created.txt', text: 'old\n' }])
    expect(created.changed).toBe(true)
    const original = await readOne(call, 'created.txt')
    // 整份替换保留文件原来的换行：正文里的 CRLF 落盘成 LF。
    await edit(call, [{ action: 'overwrite', fileRef: original.fileRef, text: 'complete\r\n' }])
    expect(await disk('created.txt')).toBe('complete\n')
    const source = await readOne(call, 'created.txt')
    await edit(call, [{ action: 'move', fileRef: source.fileRef, to: 'moved.txt' }])
    await expect(readFile(join(root, 'created.txt'))).rejects.toThrow()
    const moved = await readOne(call, 'moved.txt')
    const deleted = await edit(call, [{ action: 'delete', fileRef: moved.fileRef }])
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
    const inspected = await call('project', 'inspect', { changeRef: deleted.changeRef })
    expect(inspected.changedFiles).toContain('moved.txt')
    expect(inspected.status).toBe('applied')
    expect(inspected.oldRevisions['moved.txt']).toBe(moved.revision)
    expect(inspected.newRevisions['moved.txt']).toBe('deleted')
    expect(inspected.diff).toContain('-complete')
    const undone = await call('project', 'undo', { changeRef: deleted.changeRef })
    expect(undone).toEqual({ changeRef: deleted.changeRef, changedFiles: ['moved.txt'] })
    expect((await call('project', 'inspect', { changeRef: deleted.changeRef })).status).toBe('rolled_back')
    expect(await disk('moved.txt')).toBe('complete\n')
  })

  test('整份替换要求看过全文：只读了几行的 fileRef 覆盖不了整个文件，移动照常', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const { call } = await projectToolFixture({ root })
    const partial = await readOne(call, 'a.txt', [1, 2])
    expect((await failureOf(edit(call, [{ action: 'overwrite', fileRef: partial.fileRef, text: 'replaced\n' }]))).code).toBe('SCOPE_VIOLATION')
    expect(await disk('a.txt')).toBe('one\ntwo\nthree\nfour\n')
    // move、delete 不动正文，只核对版本，照旧收只看过一段的 fileRef。
    const moved = await edit(call, [{ action: 'move', fileRef: partial.fileRef, to: 'b.txt' }])
    expect(moved.changedFiles.sort()).toEqual(['a.txt', 'b.txt'])
    const whole = await readOne(call, 'b.txt')
    const overwritten = await edit(call, [{ action: 'overwrite', fileRef: whole.fileRef, text: 'replaced\n' }])
    expect(overwritten.changed).toBe(true)
    expect(await disk('b.txt')).toBe('replaced\n')
  })

  test('回执带提交前后的版本：新建的文件不在 oldRevisions 里；撤销两次照样成功', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    const result = await edit(call, [
      { action: 'create', path: 'fresh.txt', text: 'new\n' },
      { action: 'edit', fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'two' }] },
    ])
    // 界面按 changedFiles 加前后版本画改动摘要：新建的文件「不在 oldRevisions 里」就是它的标志。
    expect(result.oldRevisions['a.txt']).toBe(file.revision)
    expect(result.oldRevisions['fresh.txt']).toBeUndefined()
    expect(result.newRevisions['fresh.txt']).toBeTruthy()
    expect(result.diffLines).toBeGreaterThan(0)
    expect(result.diffTruncated).toBeUndefined()
    await call('project', 'undo', { changeRef: result.changeRef })
    const again = await call('project', 'undo', { changeRef: result.changeRef })
    expect(again).toMatchObject({ changeRef: result.changeRef, alreadyUndone: true })
    expect(await disk('a.txt')).toBe('one\n')
    await expect(readFile(join(root, 'fresh.txt'))).rejects.toThrow()
  })

  test('changed 说的是净变化：内容没变、步骤互相抵消都算没变，空文件的新建、移动、删除算变了', async () => {
    await writeFile(join(root, 'a.txt'), 'same\n')
    const { call } = await projectToolFixture({ root })
    const first = await readOne(call, 'a.txt')
    const unchanged = await editLine(call, first.fileRef, 1, 'same')
    expect(unchanged.changed).toBe(false)
    expect((await call('project', 'inspect', { changeRef: unchanged.changeRef })).status).toBe('applied')
    const current = await readOne(call, 'a.txt')
    expect((await edit(call, [{ action: 'overwrite', fileRef: current.fileRef, text: 'same\n' }])).changed).toBe(false)

    expect((await edit(call, [{ action: 'create', path: 'empty.txt', text: '' }])).changed).toBe(true)
    const emptyView = await readOne(call, 'empty.txt')
    expect((await edit(call, [{ action: 'move', fileRef: emptyView.fileRef, to: 'moved-empty.txt' }])).changed).toBe(true)
    const movedView = await readOne(call, 'moved-empty.txt')
    expect((await edit(call, [{ action: 'delete', fileRef: movedView.fileRef }])).changed).toBe(true)

    const cancelled = await edit(call, [{ action: 'create', path: 'temporary.txt', text: '' }, { action: 'delete', path: 'temporary.txt' }])
    expect(cancelled.changed).toBe(false)
    await expect(readFile(join(root, 'temporary.txt'))).rejects.toThrow()
    const movedSource = await readOne(call, 'a.txt')
    const roundTrip = await edit(call, [
      { action: 'move', fileRef: movedSource.fileRef, to: 'transit.txt' }, { action: 'move', sourceRef: movedSource.fileRef, to: 'a.txt' },
    ])
    expect(roundTrip.changed).toBe(false)
    expect(await disk('a.txt')).toBe('same\n')
  })

  test('同一次里新建的文件用 path 接着改、移走的文件用 sourceRef 接着改，撤销恢复所有路径', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    const result = await edit(call, [
      { action: 'create', path: 'new.txt', text: 'created\n' },
      { action: 'move', fileRef: file.fileRef, to: 'moved.txt' },
      { action: 'edit', sourceRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'moved' }] },
      { action: 'edit', path: 'new.txt', edits: [{ op: 'insert', at: 'end', text: 'checked' }] },
    ])
    expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'new.txt', 'moved.txt']))
    expect(await disk('moved.txt')).toBe('moved\n')
    expect(await disk('new.txt')).toBe('created\nchecked\n')
    // 移走的旧路径不给窗口，新路径各有一个带 fileRef 的窗口。
    expect(result.files.map((window: { path: string }) => window.path).sort()).toEqual(['moved.txt', 'new.txt'])
    await call('project', 'undo', { changeRef: result.changeRef })
    expect(await disk('a.txt')).toBe('old\n')
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
  })

  test('create 与 move 不覆盖已有文件，目标已存在就拒', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const { call } = await projectToolFixture({ root })
    expect((await failureOf(edit(call, [{ action: 'create', path: 'a.txt', text: 'x\n' }]))).code).toBe('TARGET_EXISTS')
    const file = await readOne(call, 'a.txt')
    const exists = await failureOf(edit(call, [{ action: 'move', fileRef: file.fileRef, to: 'b.txt' }]))
    expect(exists.code).toBe('TARGET_EXISTS')
    expect(exists.message).toContain('overwrite')
    expect([await disk('a.txt'), await disk('b.txt')]).toEqual(['a\n', 'b\n'])
  })

  test('入参自己核对：步骤的形状不对当场拒绝，一步都不做', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    const { call, kernel } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    for (const steps of [
      [],
      [{ action: 'rename', path: 'a.txt', to: 'b.txt' }],
      [{ action: 'edit', edits: [{ op: 'replace', range: 1, text: 'x' }] }],
      [{ action: 'edit', fileRef: file.fileRef, path: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'x' }] }],
      [{ action: 'edit', fileRef: file.fileRef, edits: [] }],
      [{ action: 'edit', fileRef: file.fileRef, edits: [{ op: 'replace', range: [2, 1], text: 'x' }] }],
      [{ action: 'create', path: 'b.txt' }],
      [{ action: 'recode', paths: ['a.txt'], encoding: 'latin1' }],
    ]) expect((await failureOf(edit(call, steps))).code, JSON.stringify(steps)).toBe('INVALID_INPUT')
    // 伪造的 fileRef 同样当场拒绝，说清楚要从哪儿原样拿。
    const forged = await failureOf(editLine(call, 'view:abc', 1, 'x'))
    expect(forged.code).toBe('INVALID_INPUT')
    expect(forged.message).toContain('不能手写')
    expect(kernel.changeFeed.list()).toEqual([])
    expect(await disk('a.txt')).toBe('a\n')
  })
})

describe('治理：没有名单，只有校验', () => {
  test('生成出来的文件也改得动：没有生成文件名单', async () => {
    const { call } = await projectToolFixture({ root })
    await edit(call, [{ action: 'create', path: 'src/api.generated.ts', text: 'export {}\n' }])
    expect(await disk('src/api.generated.ts')).toBe('export {}\n')
  })

  test('改完的内容过不了校验：文件原样，message 里带诊断', async () => {
    await writeFile(join(root, 'config.json'), '{"enabled":true}\n')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'config.json')
    const failure = await failureOf(editLine(call, file.fileRef, 1, '{invalid'))
    expect(failure.code).toBe('VALIDATION_FAILED')
    expect(failure.message).toContain('诊断')
    expect(await disk('config.json')).toBe('{"enabled":true}\n')
  })
})

describe('fileRef 的新鲜度', () => {
  test('只动了 mtime、正文没变的文件，fileRef 照样能用', async () => {
    await writeFile(join(root, 'a.txt'), 'keep\n')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    await utimes(join(root, 'a.txt'), new Date(2001, 1, 1), new Date(2001, 1, 1))
    await editLine(call, file.fileRef, 1, 'kept')
    expect(await disk('a.txt')).toBe('kept\n')
  })

  test('外部同大小、同 mtime 的改动也瞒不过 fileRef', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.ts')
    const before = await stat(join(root, 'a.ts'))
    await writeFile(join(root, 'a.ts'), 'other')
    await utimes(join(root, 'a.ts'), before.atime, before.mtime)
    expect((await failureOf(editLine(call, file.fileRef, 1, 'x'))).code).toBe('BASE_REVISION_MISMATCH')
    expect(await disk('a.ts')).toBe('other')
    expect((await readOne(call, 'a.ts')).lines).toEqual([[1, 'other']])
  })

  test('用回执里的新 fileRef 接着改，不用再读；还拿旧的就报过期', async () => {
    const original = 'const ready = false\n// 尾部🙂\\n\n'
    await writeFile(join(root, 'a.ts'), original)
    const { call } = await projectToolFixture({ root })
    const read = await readOne(call, 'a.ts')
    const first = await editLine(call, read.fileRef, 1, 'const ready = true')
    const [window] = first.files
    expect(window.lines).toContainEqual([1, 'const ready = true'])
    await editLine(call, window.fileRef, 1, 'const ready = verified()')
    expect(await disk('a.ts')).toBe('const ready = verified()\n// 尾部🙂\\n\n')
    expect((await failureOf(editLine(call, window.fileRef, 1, 'const ready = 9'))).code).toBe('BASE_REVISION_MISMATCH')
    expect(await disk('a.ts')).toBe('const ready = verified()\n// 尾部🙂\\n\n')
  })
})

describe('回执窗口', () => {
  test('此前读到的范围沿补丁迁到新内容上：改完接着改那一片，不用重读', async () => {
    const body = `${Array.from({ length: 900 }, (_, index) => `const value${index + 1} = ${'x'.repeat(40)}`).join('\n')}\n`
    await writeFile(join(root, 'big.ts'), body)
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'big.ts', [1, 300])
    const result = await edit(call, [{ action: 'edit', fileRef: file.fileRef, edits: [{ op: 'insert', range: 100, side: 'after', text: 'const added = 1' }] }])
    const lines = result.files.flatMap((window: { lines: Array<[number, string]> }) => window.lines)
    expect(lines[0]).toEqual([1, `const value1 = ${'x'.repeat(40)}`])
    expect(lines).toContainEqual([101, 'const added = 1'])
    expect(lines.at(-1)).toEqual([301, `const value300 = ${'x'.repeat(40)}`])
    const [{ fileRef }] = result.files
    await editLine(call, fileRef, 251, 'const value250 = 0')
    expect((await disk('big.ts')).split('\n')[250]).toBe('const value250 = 0')
  })

  test('一个事务改 100 个文件：全成；回执给每个文件一个新版本上的窗口，差量是完整的', async () => {
    const paths = Array.from({ length: 100 }, (_, index) => `${index}.txt`)
    await Promise.all(paths.map((path, index) => writeFile(join(root, path), `before-${index}`)))
    const { call } = await projectToolFixture({ root })
    const windows: Array<{ path: string; fileRef: string }> = []
    for (let start = 0; start < paths.length; start += 20)
      windows.push(...(await call('project', 'read', { files: paths.slice(start, start + 20).map((path) => ({ path })) })).files)
    const result = await edit(call, windows.map((window, index) => ({ action: 'edit', fileRef: window.fileRef, edits: [{ op: 'replace', match: `before-${index}`, text: `after-${index}` }] })))
    expect(result.changedFiles).toHaveLength(100)
    for (const [index, path] of paths.entries()) expect(await disk(path)).toBe(`after-${index}`)
    expect(result.files.map((window: { path: string }) => window.path).sort()).toEqual([...paths].sort())
    for (const window of result.files) {
      expect(window.revision, window.path).toBe(result.newRevisions[window.path])
      expect(window.fileRef, window.path).toStartWith('view:')
      expect(window.lines[0][1], window.path).toBe(`after-${window.path.replace('.txt', '')}`)
    }
    // 不裁差量：每个文件的改动都在 diff 里，inspect 给的是同一份。
    for (const [index] of paths.entries()) expect(result.diff).toContain(`+after-${index}`)
    expect((await call('project', 'inspect', { changeRef: result.changeRef })).diff).toBe(result.diff)
    // 再多一个文件就整批拒绝，一个都不写。
    const tooMany = await failureOf(edit(call, Array.from({ length: 101 }, (_, index) => ({ action: 'create', path: `new-${index}.txt`, text: 'x' }))))
    expect(tooMany.code).toBe('SCOPE_VIOLATION')
    await expect(readFile(join(root, 'new-0.txt'))).rejects.toThrow()
  }, 30_000)

  test('提交之后文件立刻被外部改掉：回执照样成立，只是不给那个文件的窗口，撤销也不覆盖外部改动', async () => {
    await writeFile(join(root, 'a.txt'), 'A')
    const { call, kernel } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    const apply = kernel.applyEdit.bind(kernel)
    kernel.applyEdit = async (input) => {
      const applied = await apply(input)
      await writeFile(join(root, 'a.txt'), 'C')
      return applied
    }
    const result = await edit(call, [{ action: 'edit', fileRef: file.fileRef, edits: [{ op: 'replace', match: 'A', text: 'B' }] }])
    expect(result.changed).toBe(true)
    expect(result.files).toEqual([])
    expect(await disk('a.txt')).toBe('C')
    expect((await failureOf(call('project', 'undo', { changeRef: result.changeRef }))).code).toBe('CONFLICT_WITH_EXTERNAL_EDIT')
    expect(await disk('a.txt')).toBe('C')
  })
})

describe('inspect 与 undo', () => {
  test('撤销遇到之后的外部改动整个拒绝；不认识的 changeRef 按入参不对拒绝；两样都什么都没写', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await projectToolFixture({ root })
    const edited = await editLine(call, (await readOne(call, 'a.txt')).fileRef, 1, 'two')
    await writeFile(join(root, 'a.txt'), 'three\n')
    expect((await failureOf(call('project', 'undo', { changeRef: edited.changeRef }))).code).toBe('CONFLICT_WITH_EXTERNAL_EDIT')
    const unknown = await failureOf(call('project', 'undo', { changeRef: `change:${'0'.repeat(64)}` }))
    expect(unknown.code).toBe('INVALID_INPUT')
    expect(unknown.message).toContain('changeRef')
    expect((await failureOf(call('project', 'inspect', { changeRef: 'view:abc' }))).code).toBe('INVALID_INPUT')
    expect(await disk('a.txt')).toBe('three\n')
    expect((await call('project', 'inspect', { changeRef: edited.changeRef })).status).toBe('applied')
  })
})

describe('版本过期的恢复', () => {
  /** 一个看过整份正文的视图。 */
  function view(content: string) {
    return { path: 'a.txt', revision: 'A', content, coverage: completeProjectCoverage(content) }
  }

  test('只有目标连同能区分它的上下文都还在时才给新位置', () => {
    const original = 'head\nstart\nunique\nold\nend\ntail\n'
    const edits = [{ op: 'replace' as const, range: 4, text: 'new' }]
    expect(suggestProjectEditLocations(view(original), edits, `extra\n${original}`)).toEqual([{ editIndex: 0, range: 5, unchanged: true }])
    expect(suggestProjectEditLocations(view(original), edits, original.replace('old', 'external'))).toBeUndefined()
    expect(suggestProjectEditLocations(view(original), edits, `${original}${original}`)).toBeUndefined()
  })

  test('首末两行没变挡不住中间一行被改', () => {
    const original = 'header\nfirst\nmiddle\nlast\nfooter\n'
    expect(suggestProjectEditLocations(view(original), [{ op: 'replace', range: [2, 4], text: 'replacement' }], original.replace('middle', 'changed'))).toBeUndefined()
  })

  test('CRLF 与 Unicode 的重新定位按物理行算', () => {
    const original = '// 中文🙂\r\nfirst\r\nold\\path\r\nlast\r\n'
    expect(suggestProjectEditLocations(view(original), [{ op: 'replace', range: [3], match: 'old\\path', text: 'new\\path' }], `header\r\n${original}`))
      .toEqual([{ editIndex: 0, range: 4, unchanged: true }])
  })

  test('还能唯一找到原来的位置：message 给新行号与新 fileRef，照着重提就成，旧意图不会被自动套用', async () => {
    const original = 'header\nstart\nunique\nold\nend\ntail\n'
    await writeFile(join(root, 'a.txt'), original)
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    const current = `extra\n${original}`
    await writeFile(join(root, 'a.txt'), current)
    const failure = await failureOf(editLine(call, file.fileRef, 4, 'new'))
    expect(failure.code).toBe('BASE_REVISION_MISMATCH')
    expect(failure.message).toContain('第 1 处编辑现在在第 5 行')
    expect(failure.message).toContain('5: old')
    expect(await disk('a.txt')).toBe(current)
    const fileRef = /view:[a-f0-9]{64}/.exec(failure.message)?.[0]
    expect(fileRef).toBeDefined()
    await editLine(call, fileRef!, 5, 'new')
    expect(await disk('a.txt')).toBe(current.replace('\nold\n', '\nnew\n'))
    // 确认窗口的 fileRef 只管那一刻的内容：改完再拿它就过期了。
    expect((await failureOf(editLine(call, fileRef!, 5, 'duplicate'))).code).toBe('BASE_REVISION_MISMATCH')
  })

  test('找不到能确认的新位置：照常报过期，点名哪一步要换 fileRef 或重读', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\nbeta\n')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    await writeFile(join(root, 'a.txt'), 'gamma\ndelta\n')
    const failure = await failureOf(editLine(call, file.fileRef, 1, 'x'))
    expect(failure.code).toBe('BASE_REVISION_MISMATCH')
    expect(failure.message).toStartWith('steps[0]')
    expect(failure.message).toContain('重新 read')
    expect(failure.message).not.toMatch(/view:[a-f0-9]{64}/)
  })

  test('候选装不进这条说明时只给新行号，让程序先 read', async () => {
    const body = `${Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    await writeFile(join(root, 'a.txt'), body)
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    await writeFile(join(root, 'a.txt'), `inserted\n${body}`)
    const small = await failureOf(editLine(call, file.fileRef, 5, 'x'))
    expect(small.message).toContain('第 1 处编辑现在在第 6 行')
    expect(small.message).toMatch(/view:[a-f0-9]{64}/)
    const large = await failureOf(editLine(call, file.fileRef, [5, 20], 'x'))
    expect(large.code).toBe('BASE_REVISION_MISMATCH')
    expect(large.message).toContain('第 1 处编辑现在在第 6–21 行')
    expect(large.message).toContain('先 read')
    expect(large.message).not.toMatch(/view:[a-f0-9]{64}/)
    expect(await disk('a.txt')).toBe(`inserted\n${body}`)
  })
})

describe('编码与换行', () => {
  test.each(['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030'] as const)(
    '%s：读到的行、语义解析、按字面改与逐字节的撤销都一致', async (encoding) => {
      const original = 'export const message = "中文🙂\\n";\r\nexport const count = 1;\n'
      const bytes = textCodec.encode(original, encoding)
      await writeFile(join(root, 'source.ts'), bytes)
      const { call, kernel } = await projectToolFixture({ root, plugins: [typescriptPlugin()] })
      const before = await readOne(call, 'source.ts')
      expect(before.lines).toEqual([[1, 'export const message = "中文🙂\\n";'], [2, 'export const count = 1;']])
      expect(before.totalLines).toBe(2)
      expect((await kernel.listSymbols('source.ts')).map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['message', 'count']))
      const result = await edit(call, [{ action: 'edit', fileRef: before.fileRef, edits: [{ op: 'replace', range: 2, match: 'count = 1', text: 'count = 2' }] }])
      const after = [[1, 'export const message = "中文🙂\\n";'], [2, 'export const count = 2;']]
      // 回执窗口与重读看到的是同一份：行里不带 \r，转义原样。
      expect(result.files[0].lines).toEqual(after)
      expect((await readOne(call, 'source.ts')).lines).toEqual(after)
      expect(await readFile(join(root, 'source.ts'))).toEqual(textCodec.encode(original.replace('count = 1', 'count = 2'), encoding))
      await call('project', 'undo', { changeRef: result.changeRef })
      expect(await readFile(join(root, 'source.ts'))).toEqual(bytes)
    },
  )
})
