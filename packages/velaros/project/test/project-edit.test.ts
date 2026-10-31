/**
 * `velaros:project` 的改的一侧：edit 把几步按路径的改动合成一个事务、回执窗口、inspect 与 undo、按提交时的正文改、编码与换行的保留。
 * 一律经 `call('project', …)` 走真的代码面端口；失败只看程序拿得到的 error.code 与 error.message。
 */

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { textCodec } from '@velaros-ai/core/text-files'

import { typescriptPlugin } from '../index'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-edit-'))
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
}

/** 读一个文件，交回它的第一个窗口。 */
async function readOne(call: Fixture['call'], path: string, range?: unknown) {
  return (
    await call('project', 'read', { files: [range === undefined ? { path } : { path, range }] })
  ).files[0]
}

/** 提交一次 edit。 */
function edit(call: Fixture['call'], steps: unknown[]) {
  return call('project', 'edit', { steps })
}

/** 按路径把一段原文换成新文。 */
function replace(call: Fixture['call'], path: string, oldText: string, newText: string) {
  return edit(call, [{ action: 'replace', path, oldText, newText }])
}

/** 磁盘上的正文。 */
const disk = (path: string) => readFile(join(root, path), 'utf8')

describe('edit：几步合成一个事务', () => {
  test('同一个文件接连几步：后一步按前一步改完的内容算；回执窗口是改完的正文，接着改不用再读', async () => {
    await writeFile(join(root, 'a.txt'), 'header\nold\nvalue oldCall()\ntarget\nend\n')
    const { call } = await projectToolFixture({ root })
    const result = await edit(call, [
      {
        action: 'replace',
        path: 'a.txt',
        oldText: 'header\nold\n',
        newText: 'start\nheader\nnew\nextra\n',
      },
      { action: 'replace', path: 'a.txt', oldText: 'oldCall()', newText: 'newCall()' },
      // 这一步的 oldText 是前两步改出来的正文。
      {
        action: 'replace',
        path: 'a.txt',
        oldText: 'extra\nvalue newCall()',
        newText: 'extra\nvalue newCall() // checked',
      },
      { action: 'replace', path: 'a.txt', oldText: 'target', newText: 'before\ntarget!' },
      { action: 'replace', path: 'a.txt', oldText: 'end\n', newText: 'end\nfinish\n' },
    ])
    const expected =
      'start\nheader\nnew\nextra\nvalue newCall() // checked\nbefore\ntarget!\nend\nfinish\n'
    expect(result.changed).toBe(true)
    expect(result.changeRef).toStartWith('change:')
    expect(await disk('a.txt')).toBe(expected)
    // 文件小，改动处连同前后几行就是整个文件：回执窗口在新版本上，正文就是改完的样子。
    expect(result.files).toEqual([
      expect.objectContaining({
        path: 'a.txt',
        revision: result.newRevisions['a.txt'],
        startLine: 1,
        text: expected,
      }),
    ])
    await replace(call, 'a.txt', 'target!', 'confirmed')
    expect(await disk('a.txt')).toContain('confirmed\n')
    // 改掉了的原文再拿来写 oldText 就找不到，什么都不写。
    expect((await failureOf(replace(call, 'a.txt', 'value oldCall()', 'stale'))).code).toBe(
      'TARGET_NOT_FOUND'
    )
    expect(await disk('a.txt')).toBe(expected.replace('target!', 'confirmed'))
  })

  test('五万行文件两段相隔很远的一千行改动：两步一个事务提交、一次撤销；回执里两处各一个窗口', async () => {
    const content = Array.from({ length: 50_000 }, (_, index) => `row ${index + 1}`).join('\n')
    await writeFile(join(root, 'large.txt'), content)
    const { call, kernel } = await projectToolFixture({ root })
    const rows = content.split('\n')
    const changed = await edit(call, [
      // 头五百行在程序里改好，整份写回。
      {
        action: 'write',
        path: 'large.txt',
        text: rows.map((row, index) => (index < 500 ? `changed ${index + 1}` : row)).join('\n'),
      },
      // 尾五百行整段换掉：按前一步写完的内容找。
      {
        action: 'replace',
        path: 'large.txt',
        oldText: rows.slice(49_500).join('\n'),
        newText: rows
          .slice(49_500)
          .map((_, index) => `changed ${index + 49_501}`)
          .join('\n'),
      },
    ])
    // 一步一个补丁，一次事务一起提交：两步都落在 large.txt 上。
    expect(
      kernel.getTransaction(changed.transactionId)?.patches.map((patch) => patch.path)
    ).toEqual(['large.txt', 'large.txt'])
    const actual = (await disk('large.txt')).split('\n')
    expect(actual).toHaveLength(50_000)
    for (let index = 0; index < 500; index += 1) {
      expect(actual[index]).toBe(`changed ${index + 1}`)
      expect(actual[index + 49_500]).toBe(`changed ${index + 49_501}`)
    }
    expect(actual[501]).toBe('row 502')
    // 回执窗口都在新版本上：不相连的两处改动各一个窗口，中间四万多行不给。
    expect(changed.files).toEqual([
      expect.objectContaining({
        path: 'large.txt',
        revision: changed.newRevisions['large.txt'],
        startLine: 1,
      }),
      expect.objectContaining({ path: 'large.txt', revision: changed.newRevisions['large.txt'] }),
    ])
    const [head, tail] = changed.files as Window[]
    expect(head.text).toStartWith('changed 1\nchanged 2\n')
    expect(tail.text).toEndWith('changed 49999\nchanged 50000')
    expect(tail.startLine + tail.text.split('\n').length - 1).toBe(50_000)
    await call('project', 'undo', { changeRef: changed.changeRef })
    expect(await disk('large.txt')).toBe(content)
  })

  test('一步失败整批拒绝、一个文件都不写：没找到给最接近的原文，好几处给每一处；后一步按前一步改完的内容找', async () => {
    const original = 'const first = 1\nconst value = 2\nconst value = 2\n'
    await writeFile(join(root, 'a.txt'), original)
    const { call } = await projectToolFixture({ root })
    const missing = await failureOf(
      edit(call, [
        { action: 'write', path: 'new.txt', text: 'new\n' },
        { action: 'replace', path: 'a.txt', oldText: 'const  first = 1', newText: 'x' },
      ])
    )
    expect(missing.code).toBe('TARGET_NOT_FOUND')
    expect(missing.message).toStartWith('steps[1]')
    expect(missing.message).toContain('最接近')
    expect(missing.message).toContain('第 1 行')
    expect(missing.message).toContain('"const first = 1"')
    const ambiguous = await failureOf(replace(call, 'a.txt', 'const value = 2', 'x'))
    expect(ambiguous.code).toBe('AMBIGUOUS_TARGET')
    expect(ambiguous.message).toStartWith('steps[0]')
    expect(ambiguous.message).toContain('出现了 2 次')
    expect(ambiguous.message).toContain('第 2 行')
    expect(ambiguous.message).toContain('第 3 行')
    // 前一步已经把这段原文换掉了，后一步再按它找就找不到。
    const consumed = await failureOf(
      edit(call, [
        { action: 'replace', path: 'a.txt', oldText: 'const first = 1', newText: 'const one = 1' },
        {
          action: 'replace',
          path: 'a.txt',
          oldText: 'const first = 1\nconst value = 2',
          newText: 'x',
        },
      ])
    )
    expect(consumed.code).toBe('TARGET_NOT_FOUND')
    expect(consumed.message).toStartWith('steps[1]')
    expect(await disk('a.txt')).toBe(original)
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
  })

  test('新建、整份写入、移动、删除都有回执；inspect 看得到前后版本，undo 恢复最后的那个文件', async () => {
    const { call } = await projectToolFixture({ root })
    const created = await edit(call, [{ action: 'write', path: 'created.txt', text: 'old\n' }])
    expect(created.changed).toBe(true)
    // 整份写入保留文件原来的换行：正文里的 CRLF 落盘成 LF。
    await edit(call, [{ action: 'write', path: 'created.txt', text: 'complete\r\n' }])
    expect(await disk('created.txt')).toBe('complete\n')
    await edit(call, [{ action: 'move', path: 'created.txt', to: 'moved.txt' }])
    await expect(readFile(join(root, 'created.txt'))).rejects.toThrow()
    const moved = await readOne(call, 'moved.txt')
    const deleted = await edit(call, [{ action: 'delete', path: 'moved.txt' }])
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
    const inspected = await call('project', 'inspect', { changeRef: deleted.changeRef })
    expect(inspected.changedFiles).toContain('moved.txt')
    expect(inspected.status).toBe('applied')
    expect(inspected.oldRevisions['moved.txt']).toBe(moved.revision)
    expect(inspected.newRevisions['moved.txt']).toBe('deleted')
    expect(inspected.diff).toContain('-complete')
    const undone = await call('project', 'undo', { changeRef: deleted.changeRef })
    expect(undone).toEqual({ changeRef: deleted.changeRef, changedFiles: ['moved.txt'] })
    expect((await call('project', 'inspect', { changeRef: deleted.changeRef })).status).toBe(
      'rolled_back'
    )
    expect(await disk('moved.txt')).toBe('complete\n')
  })

  test('write 不用先读：只读过几行的、没读过的文件都能整份换掉，缺的上级目录自动建；移动也不用先读', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const { call } = await projectToolFixture({ root })
    await readOne(call, 'a.txt', [1, 2])
    const written = await edit(call, [
      { action: 'write', path: 'a.txt', text: 'replaced\n' },
      { action: 'write', path: 'src/deep/new.txt', text: 'fresh\n' },
    ])
    expect(written.changedFiles.sort()).toEqual(['a.txt', 'src/deep/new.txt'])
    expect(await disk('a.txt')).toBe('replaced\n')
    expect(await disk('src/deep/new.txt')).toBe('fresh\n')
    const moved = await edit(call, [{ action: 'move', path: 'a.txt', to: 'b.txt' }])
    expect(moved.changedFiles.sort()).toEqual(['a.txt', 'b.txt'])
    expect(await disk('b.txt')).toBe('replaced\n')
  })

  test('回执带提交前后的版本：新建的文件不在 oldRevisions 里；撤销两次照样成功', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await projectToolFixture({ root })
    const file = await readOne(call, 'a.txt')
    const result = await edit(call, [
      { action: 'write', path: 'fresh.txt', text: 'new\n' },
      { action: 'replace', path: 'a.txt', oldText: 'one', newText: 'two' },
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
    const unchanged = await replace(call, 'a.txt', 'same', 'same')
    expect(unchanged.changed).toBe(false)
    expect((await call('project', 'inspect', { changeRef: unchanged.changeRef })).status).toBe(
      'applied'
    )
    expect((await edit(call, [{ action: 'write', path: 'a.txt', text: 'same\n' }])).changed).toBe(
      false
    )

    expect((await edit(call, [{ action: 'write', path: 'empty.txt', text: '' }])).changed).toBe(
      true
    )
    expect(
      (await edit(call, [{ action: 'move', path: 'empty.txt', to: 'moved-empty.txt' }])).changed
    ).toBe(true)
    expect((await edit(call, [{ action: 'delete', path: 'moved-empty.txt' }])).changed).toBe(true)

    const cancelled = await edit(call, [
      { action: 'write', path: 'temporary.txt', text: '' },
      { action: 'delete', path: 'temporary.txt' },
    ])
    expect(cancelled.changed).toBe(false)
    await expect(readFile(join(root, 'temporary.txt'))).rejects.toThrow()
    const roundTrip = await edit(call, [
      { action: 'move', path: 'a.txt', to: 'transit.txt' },
      { action: 'move', path: 'transit.txt', to: 'a.txt' },
    ])
    expect(roundTrip.changed).toBe(false)
    expect(await disk('a.txt')).toBe('same\n')
  })

  test('同一次里新建的文件、移走的文件都按新路径接着改，撤销恢复所有路径', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call } = await projectToolFixture({ root })
    const result = await edit(call, [
      { action: 'write', path: 'new.txt', text: 'created\n' },
      { action: 'move', path: 'a.txt', to: 'moved.txt' },
      { action: 'replace', path: 'moved.txt', oldText: 'old', newText: 'moved' },
      { action: 'replace', path: 'new.txt', oldText: 'created\n', newText: 'created\nchecked\n' },
    ])
    expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'new.txt', 'moved.txt']))
    expect(await disk('moved.txt')).toBe('moved\n')
    expect(await disk('new.txt')).toBe('created\nchecked\n')
    // 移走的旧路径不给窗口，新路径各有一个窗口，正文就是改完的样子。
    expect(result.files.map((window: Window) => window.path).sort()).toEqual([
      'moved.txt',
      'new.txt',
    ])
    for (const window of result.files as Window[])
      expect(window.text, window.path).toBe(await disk(window.path))
    await call('project', 'undo', { changeRef: result.changeRef })
    expect(await disk('a.txt')).toBe('old\n')
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
  })

  test('移走、删掉的路径在这次改动里就没有了：再 write 它是新建，再 replace 它说已经移走，不会落到移走的那份上', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const { call } = await projectToolFixture({ root })
    await edit(call, [
      { action: 'move', path: 'a.txt', to: 'b.txt' },
      { action: 'write', path: 'a.txt', text: 'fresh\n' },
    ])
    expect([await disk('a.txt'), await disk('b.txt')]).toEqual(['fresh\n', 'alpha\n'])
    const moved = await failureOf(
      edit(call, [
        { action: 'move', path: 'b.txt', to: 'c.txt' },
        { action: 'replace', path: 'b.txt', oldText: 'alpha', newText: 'x' },
      ])
    )
    expect(moved.code).toBe('TARGET_NOT_FOUND')
    expect(moved.message).toContain('steps[1]')
    expect(moved.message).toContain('移走或删掉')
    expect(await disk('b.txt')).toBe('alpha\n')
    await expect(readFile(join(root, 'c.txt'))).rejects.toThrow()
    await edit(call, [
      { action: 'delete', path: 'a.txt' },
      { action: 'write', path: 'a.txt', text: 'again\n' },
    ])
    expect(await disk('a.txt')).toBe('again\n')
  })

  test('move 不覆盖已有文件（本次前面新建的也算），目标已存在就拒；要整份换掉用 write', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const { call } = await projectToolFixture({ root })
    const exists = await failureOf(edit(call, [{ action: 'move', path: 'a.txt', to: 'b.txt' }]))
    expect(exists.code).toBe('TARGET_EXISTS')
    expect(exists.message).toContain('write')
    const staged = await failureOf(
      edit(call, [
        { action: 'write', path: 'c.txt', text: 'c\n' },
        { action: 'move', path: 'a.txt', to: 'c.txt' },
      ])
    )
    expect(staged.code).toBe('TARGET_EXISTS')
    expect([await disk('a.txt'), await disk('b.txt')]).toEqual(['a\n', 'b\n'])
    await expect(readFile(join(root, 'c.txt'))).rejects.toThrow()
  })

  test('入参自己核对：步骤的形状不对当场拒绝，路径出了项目也拒，一步都不做', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    const { call, kernel } = await projectToolFixture({ root })
    for (const steps of [
      [],
      [{ action: 'rename', path: 'a.txt', to: 'b.txt' }],
      [{ action: 'replace', oldText: 'a', newText: 'x' }],
      [{ action: 'replace', path: 'a.txt', oldText: '', newText: 'x' }],
      [{ action: 'replace', path: 'a.txt', oldText: 'a', text: 'x' }],
      [{ action: 'write', path: 'b.txt' }],
      [{ action: 'write', path: '', text: 'x' }],
      [{ action: 'move', path: 'a.txt' }],
      [{ action: 'delete' }],
      // 凭 fileRef、按行号的步骤是编辑规划内部的写法，模型写不进来。
      [{ action: 'edit', path: 'a.txt', edits: [{ op: 'replace', range: 1, text: 'x' }] }],
      [{ action: 'recode', paths: ['a.txt'], encoding: 'latin1' }],
    ])
      expect((await failureOf(edit(call, steps))).code, JSON.stringify(steps)).toBe('INVALID_INPUT')
    for (const step of [
      { action: 'write', path: '../outside.txt', text: 'x' },
      { action: 'move', path: 'a.txt', to: '../outside.txt' },
    ]) {
      const denied = await failureOf(
        edit(call, [{ action: 'write', path: 'ok.txt', text: 'x' }, step])
      )
      expect(denied.code, JSON.stringify(step)).toBe('PERMISSION_DENIED')
      // 出错的是第几步写在最前面，前一步也没写。
      expect(denied.message, JSON.stringify(step)).toStartWith('steps[1]：')
    }
    await expect(readFile(join(root, 'ok.txt'))).rejects.toThrow()
    expect(kernel.changeFeed.list()).toEqual([])
    expect(await disk('a.txt')).toBe('a\n')
  })
})

describe('治理：没有名单，只有校验', () => {
  test('生成出来的文件也改得动：没有生成文件名单', async () => {
    const { call } = await projectToolFixture({ root })
    await edit(call, [{ action: 'write', path: 'src/api.generated.ts', text: 'export {}\n' }])
    expect(await disk('src/api.generated.ts')).toBe('export {}\n')
  })

  test('改完的内容过不了校验：文件原样，message 里带诊断', async () => {
    await writeFile(join(root, 'config.json'), '{"enabled":true}\n')
    const { call } = await projectToolFixture({ root })
    const failure = await failureOf(replace(call, 'config.json', '{"enabled":true}', '{invalid'))
    expect(failure.code).toBe('VALIDATION_FAILED')
    expect(failure.message).toContain('诊断')
    expect(await disk('config.json')).toBe('{"enabled":true}\n')
  })
})

describe('按提交时的正文改', () => {
  test('读过之后文件被外部改了：replace 按现在的正文找原文，改的是挪了位置的那一处，外部的改动留着', async () => {
    const original = 'header\nstart\nunique\nold\nend\ntail\n'
    await writeFile(join(root, 'a.txt'), original)
    const { call } = await projectToolFixture({ root })
    expect(await readOne(call, 'a.txt', 4)).toMatchObject({ startLine: 4, text: 'old' })
    const current = `extra\n${original}`
    await writeFile(join(root, 'a.txt'), current)
    const result = await replace(call, 'a.txt', 'old\n', 'new\n')
    const expected = current.replace('\nold\n', '\nnew\n')
    expect(await disk('a.txt')).toBe(expected)
    // 回执照现在的行号：外部在前面插了一行，原来的第 4 行现在是第 5 行。
    expect(result.files).toEqual([expect.objectContaining({ startLine: 1, text: expected })])
    expect(result.files[0].text.split('\n')[4]).toBe('new')
  })

  test('外部同大小、同 mtime 的改动：照样按真实的正文找，原文没了就 TARGET_NOT_FOUND，什么都不写', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    const { call } = await projectToolFixture({ root })
    expect((await readOne(call, 'a.ts')).text).toBe('first')
    const before = await stat(join(root, 'a.ts'))
    await writeFile(join(root, 'a.ts'), 'other')
    await utimes(join(root, 'a.ts'), before.atime, before.mtime)
    const failure = await failureOf(replace(call, 'a.ts', 'first', 'x'))
    expect(failure.code).toBe('TARGET_NOT_FOUND')
    expect(failure.message).toStartWith('steps[0]')
    expect(await disk('a.ts')).toBe('other')
    expect((await readOne(call, 'a.ts')).text).toBe('other')
  })

  test('照回执窗口里的正文接着改，不用再读；再按改掉的原文找就找不到', async () => {
    const original = 'const ready = false\n// 尾部🙂\\n\n'
    await writeFile(join(root, 'a.ts'), original)
    const { call } = await projectToolFixture({ root })
    const first = await replace(call, 'a.ts', 'const ready = false', 'const ready = true')
    const [window] = first.files
    expect(window).toMatchObject({ startLine: 1, text: 'const ready = true\n// 尾部🙂\\n\n' })
    const [line] = window.text.split('\n')
    await replace(call, 'a.ts', line, 'const ready = verified()')
    expect(await disk('a.ts')).toBe('const ready = verified()\n// 尾部🙂\\n\n')
    expect((await failureOf(replace(call, 'a.ts', line, 'const ready = 9'))).code).toBe(
      'TARGET_NOT_FOUND'
    )
    expect(await disk('a.ts')).toBe('const ready = verified()\n// 尾部🙂\\n\n')
  })
})

describe('回执窗口', () => {
  test('回执窗口只给改动处连同前后几行：此前读到的范围不跟着给；接着改也不用重读', async () => {
    const row = (index: number) => `const value${index} = ${'x'.repeat(40)}`
    const body = `${Array.from({ length: 900 }, (_, index) => row(index + 1)).join('\n')}\n`
    await writeFile(join(root, 'big.ts'), body)
    const { call } = await projectToolFixture({ root })
    await readOne(call, 'big.ts', [1, 300])
    const result = await replace(call, 'big.ts', `${row(100)}\n`, `${row(100)}\nconst added = 1\n`)
    // 只有一处改动，就一个窗口：新加的是第 101 行，前后各带几行；读过的第 1–300 行不跟着给。
    expect(result.files).toHaveLength(1)
    const [window] = result.files as Window[]
    const lines = window.text.split('\n')
    const at = (line: number) => lines[line - window.startLine]
    expect(window.startLine).toBeGreaterThan(1)
    expect(lines.length).toBeLessThan(30)
    expect(at(96)).toBe(row(96))
    expect(at(101)).toBe('const added = 1')
    expect(at(106)).toBe(row(105))
    await replace(call, 'big.ts', row(250), 'const value250 = 0')
    expect((await disk('big.ts')).split('\n')[250]).toBe('const value250 = 0')
  })

  test('一个事务改 100 个文件：全成；回执给每个文件一个新版本上的窗口，差量是完整的', async () => {
    const paths = Array.from({ length: 100 }, (_, index) => `${index}.txt`)
    await Promise.all(paths.map((path, index) => writeFile(join(root, path), `before-${index}`)))
    const { call } = await projectToolFixture({ root })
    const result = await edit(
      call,
      paths.map((path, index) => ({
        action: 'replace',
        path,
        oldText: `before-${index}`,
        newText: `after-${index}`,
      }))
    )
    expect(result.changedFiles).toHaveLength(100)
    for (const [index, path] of paths.entries()) expect(await disk(path)).toBe(`after-${index}`)
    expect(result.files.map((window: Window) => window.path).sort()).toEqual([...paths].sort())
    for (const window of result.files as Window[]) {
      expect(window.revision, window.path).toBe(result.newRevisions[window.path])
      expect(window.text, window.path).toBe(`after-${window.path.replace('.txt', '')}`)
    }
    // 不裁差量：每个文件的改动都在 diff 里，inspect 给的是同一份。
    for (const [index] of paths.entries()) expect(result.diff).toContain(`+after-${index}`)
    expect((await call('project', 'inspect', { changeRef: result.changeRef })).diff).toBe(
      result.diff
    )
    // 再多一个文件就整批拒绝，一个都不写。
    const tooMany = await failureOf(
      edit(
        call,
        Array.from({ length: 101 }, (_, index) => ({
          action: 'write',
          path: `new-${index}.txt`,
          text: 'x',
        }))
      )
    )
    expect(tooMany.code).toBe('SCOPE_VIOLATION')
    await expect(readFile(join(root, 'new-0.txt'))).rejects.toThrow()
  }, 30_000)

  test('提交之后文件立刻被外部改掉：回执照样成立，只是不给那个文件的窗口，撤销也不覆盖外部改动', async () => {
    await writeFile(join(root, 'a.txt'), 'A')
    const { call, kernel } = await projectToolFixture({ root })
    const apply = kernel.applyEdit.bind(kernel)
    kernel.applyEdit = async (input) => {
      const applied = await apply(input)
      await writeFile(join(root, 'a.txt'), 'C')
      return applied
    }
    const result = await replace(call, 'a.txt', 'A', 'B')
    expect(result.changed).toBe(true)
    expect(result.files).toEqual([])
    expect(await disk('a.txt')).toBe('C')
    expect((await failureOf(call('project', 'undo', { changeRef: result.changeRef }))).code).toBe(
      'CONFLICT_WITH_EXTERNAL_EDIT'
    )
    expect(await disk('a.txt')).toBe('C')
  })
})

describe('inspect 与 undo', () => {
  test('撤销遇到之后的外部改动整个拒绝；不认识的 changeRef 按入参不对拒绝；两样都什么都没写', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await projectToolFixture({ root })
    const edited = await replace(call, 'a.txt', 'one', 'two')
    await writeFile(join(root, 'a.txt'), 'three\n')
    expect((await failureOf(call('project', 'undo', { changeRef: edited.changeRef }))).code).toBe(
      'CONFLICT_WITH_EXTERNAL_EDIT'
    )
    const unknown = await failureOf(
      call('project', 'undo', { changeRef: `change:${'0'.repeat(64)}` })
    )
    expect(unknown.code).toBe('INVALID_INPUT')
    expect(unknown.message).toContain('changeRef')
    expect((await failureOf(call('project', 'inspect', { changeRef: 'view:abc' }))).code).toBe(
      'INVALID_INPUT'
    )
    expect(await disk('a.txt')).toBe('three\n')
    expect((await call('project', 'inspect', { changeRef: edited.changeRef })).status).toBe(
      'applied'
    )
  })
})

describe('编码与换行', () => {
  test.each([
    'utf8',
    'utf8-bom',
    'utf16le',
    'utf16be',
    'utf16le-nobom',
    'utf16be-nobom',
    'gb18030',
  ] as const)('%s：读到的正文、语义解析、按原文改与逐字节的撤销都一致', async (encoding) => {
    const original = 'export const message = "中文🙂\\n";\r\nexport const count = 1;\n'
    const bytes = textCodec.encode(original, encoding)
    await writeFile(join(root, 'source.ts'), bytes)
    const { call, kernel } = await projectToolFixture({ root, plugins: [typescriptPlugin()] })
    const before = await readOne(call, 'source.ts')
    expect(before).toMatchObject({
      startLine: 1,
      text: 'export const message = "中文🙂\\n";\nexport const count = 1;\n',
      totalLines: 2,
    })
    expect((await kernel.listSymbols('source.ts')).map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['message', 'count'])
    )
    const result = await replace(call, 'source.ts', 'count = 1', 'count = 2')
    const after = 'export const message = "中文🙂\\n";\nexport const count = 2;\n'
    // 回执窗口与重读看到的是同一份：正文里不带 \r，转义原样。
    expect(result.files[0].text).toBe(after)
    expect((await readOne(call, 'source.ts')).text).toBe(after)
    expect(await readFile(join(root, 'source.ts'))).toEqual(
      textCodec.encode(original.replace('count = 1', 'count = 2'), encoding)
    )
    await call('project', 'undo', { changeRef: result.changeRef })
    expect(await readFile(join(root, 'source.ts'))).toEqual(bytes)
  })
})

describe('Node 原文直接提交保护事务', () => {
  test('一次提交两份 Node 已读原文，无项目 read/select，编码换行保留并可整批撤回', async () => {
    const original = '\ufeffconst value = 1\r\n'
    await writeFile(join(root, 'a.txt'), original)
    await writeFile(join(root, 'b.txt'), '')
    const before = await disk('a.txt')
    const { call } = await projectToolFixture({ root })
    const result = await edit(call, [
      { action: 'write', path: 'a.txt', expectedText: before, text: before.replace('1', '2') },
      { action: 'write', path: 'b.txt', expectedText: '', text: 'filled\n' },
    ])
    expect(await disk('a.txt')).toBe(original.replace('1', '2'))
    expect(await disk('b.txt')).toBe('filled\n')
    await call('project', 'undo', { changeRef: result.changeRef })
    expect(await disk('a.txt')).toBe(original)
    expect(await disk('b.txt')).toBe('')
  })

  test('Node 读取后发生外部修改时整批拒绝；不得写入其他成功项', async () => {
    await writeFile(join(root, 'a.txt'), 'before\n')
    const before = await disk('a.txt')
    await writeFile(join(root, 'a.txt'), 'external\n')
    const { call } = await projectToolFixture({ root })
    const failure = await failureOf(
      edit(call, [
        { action: 'write', path: 'new.txt', expectedText: null, text: 'new\n' },
        { action: 'write', path: 'a.txt', expectedText: before, text: 'changed\n' },
      ])
    )
    expect(failure.code).toBe('BASE_REVISION_MISMATCH')
    expect(failure.message).toContain('steps[1]')
    expect(await disk('a.txt')).toBe('external\n')
    await expect(disk('new.txt')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('null 只允许新建，空串只允许现有空文件，文件删除也算冲突', async () => {
    const { call } = await projectToolFixture({ root })
    await edit(call, [{ action: 'write', path: 'new.txt', expectedText: null, text: '' }])
    expect(
      (
        await failureOf(
          edit(call, [{ action: 'write', path: 'new.txt', expectedText: null, text: 'clobber' }])
        )
      ).code
    ).toBe('BASE_REVISION_MISMATCH')
    expect(
      (
        await failureOf(
          edit(call, [{ action: 'write', path: 'absent.txt', expectedText: '', text: 'wrong' }])
        )
      ).code
    ).toBe('BASE_REVISION_MISMATCH')
    await writeFile(join(root, 'gone.txt'), 'before')
    const before = await disk('gone.txt')
    await rm(join(root, 'gone.txt'))
    expect(
      (
        await failureOf(
          edit(call, [{ action: 'write', path: 'gone.txt', expectedText: before, text: 'wrong' }])
        )
      ).code
    ).toBe('BASE_REVISION_MISMATCH')
    expect(await disk('new.txt')).toBe('')
  })

  test('同文件步骤核对前一步的结果，失败撤回整批规划', async () => {
    await writeFile(join(root, 'a.txt'), 'one')
    const { call } = await projectToolFixture({ root })
    const steps = [
      { action: 'replace', path: 'a.txt', oldText: 'one', newText: 'two' },
      { action: 'write', path: 'a.txt', expectedText: 'one', text: 'three' },
    ]
    expect((await failureOf(edit(call, steps))).code).toBe('BASE_REVISION_MISMATCH')
    expect(await disk('a.txt')).toBe('one')
    steps[1].expectedText = 'two'
    await edit(call, steps)
    expect(await disk('a.txt')).toBe('three')
  })

  test('只改变换行也拒绝陈旧原文；提交后的外部修改阻止撤回', async () => {
    await writeFile(join(root, 'a.txt'), 'before\r\n')
    const before = await disk('a.txt')
    await writeFile(join(root, 'a.txt'), 'before\n')
    const { call } = await projectToolFixture({ root })
    expect(
      (
        await failureOf(
          edit(call, [{ action: 'write', path: 'a.txt', expectedText: before, text: 'wrong' }])
        )
      ).code
    ).toBe('BASE_REVISION_MISMATCH')
    const result = await edit(call, [
      { action: 'write', path: 'a.txt', expectedText: await disk('a.txt'), text: 'after\n' },
    ])
    await writeFile(join(root, 'a.txt'), 'external\n')
    expect((await failureOf(call('project', 'undo', { changeRef: result.changeRef }))).code).toBe(
      'CONFLICT_WITH_EXTERNAL_EDIT'
    )
    expect(await disk('a.txt')).toBe('external\n')
  })

  test('错误核对值和不支持的步骤不能静默忽略保护', async () => {
    await writeFile(join(root, 'a.txt'), 'before')
    const { call } = await projectToolFixture({ root })
    for (const expectedText of [false, 1, {}, []]) {
      expect(
        (
          await failureOf(
            edit(call, [{ action: 'write', path: 'a.txt', expectedText, text: 'wrong' }])
          )
        ).code
      ).toBe('INVALID_INPUT')
    }
    expect(
      (await failureOf(edit(call, [{ action: 'delete', path: 'a.txt', expectedText: 'before' }])))
        .code
    ).toBe('INVALID_INPUT')
    expect(await disk('a.txt')).toBe('before')
  })
})
