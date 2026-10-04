/** 版本绑定选区的产品验收：真实能力端口、真实事务、隔离临时目录，无模型调用。 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { textCodec } from '@velaros-ai/core/text-files'

import { projectFileOperations } from '../impl/operations/ProjectFileOperations'
import { failureOf, projectToolFixture } from '../test/support/tools'
import { assertVisibleSpan } from '../utils/editing/selection-coverage'
import { createProjectSourceCoordinates } from '../utils/editing/source'
import { projectStructureSpans } from '../utils/editing/structure-selection'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-selection-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
type Fixture = Awaited<ReturnType<typeof projectToolFixture>>
const disk = (path: string) => readFile(join(root, path), 'utf8')
const select = async (call: Fixture['call'], targets: unknown[]) =>
  call('project', 'select', { targets })
const read = async (call: Fixture['call'], path: string, range?: unknown) =>
  (await call('project', 'read', { files: [{ path, ...(range === undefined ? {} : { range }) }] }))
    .files[0]
const patch = (call: Fixture['call'], edits: unknown[], receipt?: string) =>
  call('project', 'patch', { edits, receipt })

describe('连续源码与精确结构定位', () => {
  test('INV-43 Python 装饰器、缩进、嵌套函数和 Unicode 原样保留，只发新块即可替换方法', async () => {
    const original =
      '# 😀说明\nclass Cache:\n    @memoize\n    async def load(self, key):\n        # 内部注释\n        return self.items[key]\n\n    def save(self):\n        return 3\n\ndef outer():\n    def inner():\n        return 1\n    return inner()\n# tail\n'
    await writeFile(join(root, 'cache.py'), original)
    const { call } = await projectToolFixture({ root })
    const result = await select(call, [
      { path: 'cache.py', symbol: 'Cache.load' },
      { path: 'cache.py', symbol: 'outer.inner' },
    ])
    expect(result.issues).toBeUndefined()
    expect(result.targets[0].text).toStartWith('    @memoize\n    async def load')
    expect(result.targets[0].text).toContain('# 内部注释')
    expect(result.targets[0].text).toEndWith('return self.items[key]\n')
    expect(result.targets[0].text).not.toEndWith('\n\n')
    expect(result.targets[1].text).toBe('    def inner():\n        return 1\n')
    expect(result.targets[0].target.ref).toMatch(/^target:[0-9a-f]{8}$/)
    const next =
      '    @memoize\n    async def load(self, key):\n        # 内部注释\n        return self.items.get(key)'
    const applied = await patch(call, [{ target: result.targets[0].target, text: next }])
    expect(applied.status).toBe('applied')
    expect(applied.diff).toBeUndefined()
    expect(applied.files).toBeUndefined()
    expect(await disk('cache.py')).toBe(original.replace('self.items[key]', 'self.items.get(key)'))
    expect((await call('project', 'inspect', { changeRef: applied.changeRef })).diff).toContain(
      'self.items.get(key)'
    )
    await call('project', 'undo', { changeRef: applied.changeRef })
    expect(await disk('cache.py')).toBe(original)
  })

  test('INV-43 JS/TS 完整限定名、JSDoc、重载、嵌套同名不任意选择', async () => {
    const original =
      '/** 保留 */\nexport function outer() {\n  function run() { return 1 }\n  return run()\n}\nexport function run(x: string): string;\nexport function run(x: number): number;\nexport function run(x: unknown) { return x }\nclass A { load() { return 1 } }\nclass B { load() { return 2 } }\n'
    await writeFile(join(root, 'api.ts'), original)
    const { call } = await projectToolFixture({ root })
    const result = await select(call, [
      { path: 'api.ts', symbol: 'outer' },
      { path: 'api.ts', symbol: 'outer.run' },
      { path: 'api.ts', symbol: 'load' },
      { path: 'api.ts', symbol: 'run' },
    ])
    expect(result.targets[0].text).toStartWith('/** 保留 */')
    expect(result.targets[1].text).toBe('  function run() { return 1 }\n')
    expect(result.issues[0].candidates.map((item: any) => item.target.label)).toEqual([
      'A.load',
      'B.load',
    ])
    expect(result.issues[1].candidates).toHaveLength(4)
    const chosen = result.issues[0].candidates[1]
    expect(
      (await patch(call, [{ target: chosen.target, text: 'load() { return 4 }' }])).status
    ).toBe('applied')
    expect(await disk('api.ts')).toBe(
      original.replace('load() { return 2 }', 'load() { return 4 }')
    )
  })

  test('INV-44 文本与坏语法可用精确片段修复，结构恢复解析不能授予错误边界', async () => {
    await writeFile(join(root, 'bad.py'), 'def broken(:\n    return 1\n')
    await writeFile(join(root, 'bad.ts'), 'function broken( {\n')
    await writeFile(join(root, 'config.txt'), 'enabled = yes\n')
    const { call } = await projectToolFixture({ root })
    const invalid = await select(call, [
      { path: 'bad.py', symbol: 'broken' },
      { path: 'bad.ts', symbol: 'broken' },
      { path: 'config.txt', symbol: 'enabled' },
    ])
    expect(invalid.targets).toHaveLength(0)
    expect(invalid.issues.map((item: any) => item.code)).toEqual([
      'NOT_SUPPORTED',
      'NOT_SUPPORTED',
      'NOT_SUPPORTED',
    ])
    const repair = (await select(call, [{ path: 'bad.py', match: 'broken(:' }])).targets[0]
    expect((await patch(call, [{ target: repair.target, text: 'broken():' }])).status).toBe(
      'applied'
    )
    expect((await select(call, [{ path: 'bad.py', symbol: 'broken' }])).targets).toHaveLength(1)
  })

  test('重复文本返回连续上下文，选择候选只改该处；零命中不作模糊写入', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nold\nsecond\nold\nend\n')
    const { call } = await projectToolFixture({ root })
    const result = await select(call, [
      { path: 'a.txt', match: 'old' },
      { path: 'a.txt', match: 'Old' },
    ])
    expect(result.issues[0].code).toBe('AMBIGUOUS_TARGET')
    expect(result.issues[0].candidates[1].context.text).toContain('second\nold\nend')
    expect(result.issues[1].code).toBe('TARGET_NOT_FOUND')
    expect(
      (await patch(call, [{ target: result.issues[0].candidates[1].target, text: 'new' }])).status
    ).toBe('applied')
    expect(await disk('a.txt')).toBe('first\nold\nsecond\nnew\nend\n')
  })
})

describe('版本、可见范围与身份边界', () => {
  test('INV-44 部分读取和断开的搜索窗口各自只绑定连续已展示区间', async () => {
    await writeFile(join(root, 'a.txt'), 'one\nshow1\nhidden\nshow2\nlast\n')
    const { call } = await projectToolFixture({ root })
    const window = await read(call, 'a.txt', 2)
    const hidden = await select(call, [{ within: window.target, match: 'hidden' }])
    expect(hidden.issues[0].code).toBe('TARGET_NOT_FOUND')
    expect((await patch(call, [{ target: window.target, text: 'changed' }])).status).toBe('applied')
    const searched = await call('project', 'search', {
      query: 'show2|one',
      path: 'a.txt',
      regex: true,
      contextLines: 0,
    })
    expect(searched.files).toHaveLength(2)
    const selected = await select(call, [{ within: searched.files[0].target, match: 'hidden' }])
    expect(selected.targets).toHaveLength(0)
    expect(
      (
        await patch(
          call,
          searched.files.map((file: any) => ({ target: file.target, text: `new ${file.text}` }))
        )
      ).status
    ).toBe('applied')
    expect(await disk('a.txt')).toBe('new one\nchanged\nhidden\nnew show2\nlast\n')
  })

  test('INV-45 外部改动即使只在目标之外也拒绝陈旧目标，整批文件保持不变', async () => {
    await writeFile(join(root, 'a.txt'), 'target\ntail\n')
    await writeFile(join(root, 'b.txt'), 'other\n')
    const { call } = await projectToolFixture({ root })
    const a = await read(call, 'a.txt')
    const b = await read(call, 'b.txt')
    await writeFile(join(root, 'a.txt'), 'target\nexternal\n')
    const result = await patch(call, [
      { target: a.target, text: 'bad' },
      { target: b.target, text: 'bad' },
    ])
    expect(result.status).toBe('blocked')
    expect(result.executionOutcome).toBe('not-applied')
    expect(result.issues[0]).toMatchObject({ index: 0, code: 'BASE_REVISION_MISMATCH' })
    expect(await disk('a.txt')).toBe('target\nexternal\n')
    expect(await disk('b.txt')).toBe('other\n')
    expect((await select(call, [{ within: a.target, match: 'target' }])).issues[0].code).toBe(
      'BASE_REVISION_MISMATCH'
    )
  })

  test('只改 mtime 不改变正文时仍可提交，客户端伪造说明不会改变目标', async () => {
    await writeFile(join(root, 'a.txt'), 'original\n')
    const { call } = await projectToolFixture({ root })
    const window = await read(call, 'a.txt')
    const before = await stat(join(root, 'a.txt'))
    await utimes(join(root, 'a.txt'), before.atime, new Date(before.mtimeMs + 5000))
    expect(
      (
        await patch(call, [
          {
            target: { ...window.target, path: '../outside.txt', start: 99, end: 100 },
            text: 'new\n',
          },
        ])
      ).status
    ).toBe('applied')
    expect(await disk('a.txt')).toBe('new\n')
  })

  test('INV-45 引用误抄、跨会话、跨项目不扩大权限；符号链接出根同样拒绝', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const one = await projectToolFixture({ root })
    const window = await read(one.call, 'a.txt')
    const two = await projectToolFixture({ root })
    expect((await patch(two.call, [{ target: window.target, text: 'bad' }])).issues[0].code).toBe(
      'INVALID_INPUT'
    )
    const typo = window.target.ref.slice(0, -1) + (window.target.ref.endsWith('0') ? '1' : '0')
    expect((await patch(one.call, [{ target: typo, text: 'bad' }])).issues[0].code).toBe(
      'INVALID_INPUT'
    )
    await mkdir(join(root, 'second'))
    const different = await projectToolFixture({
      root: join(root, 'second'),
      sessionId: one.context.sessionId,
    })
    expect(
      (await patch(different.call, [{ target: window.target, text: 'bad' }])).issues[0].code
    ).toBe('INVALID_INPUT')
    await symlink(tmpdir(), join(root, 'outside'))
    expect(
      (await select(one.call, [{ path: 'outside/file.txt', match: 'old' }])).issues[0].code
    ).toBe('PERMISSION_DENIED')
    expect(await disk('a.txt')).toBe('old\n')
  })

  test('引用种类不可互换，格式错误在提交前失败', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call } = await projectToolFixture({ root })
    const window = await read(call, 'a.txt')
    expect(
      (
        await failureOf(
          patch(call, [{ target: window.target.ref.replace('target:', 'change:'), text: 'bad' }])
        )
      ).code
    ).toBe('INVALID_INPUT')
    expect(
      (await failureOf(select(call, [{ path: 'a.txt', within: window.target, match: 'old' }]))).code
    ).toBe('INVALID_INPUT')
  })
})

describe('字符、换行与批量事务', () => {
  test.each(['utf8-bom', 'utf16le', 'utf16be', 'gb18030'] as const)(
    'INV-46 %s 编码和 CRLF 保留，UTF-16 坐标与 Unicode 正确',
    async (encoding) => {
      const original = '# prefix 中文\r\ndef load():\r\n    return "中文"\r\ntail = 1\r\n'
      await writeFile(join(root, 'a.py'), textCodec.encode(original, encoding))
      const { call } = await projectToolFixture({ root })
      const found = (await select(call, [{ path: 'a.py', symbol: 'load' }])).targets[0]
      expect(found.text).toBe('def load():\n    return "中文"\n')
      expect(
        (await patch(call, [{ target: found.target, text: 'def load():\n    return "新值"' }]))
          .status
      ).toBe('applied')
      expect(await readFile(join(root, 'a.py'))).toEqual(
        textCodec.encode(original.replace('"中文"', '"新值"'), encoding)
      )
    }
  )

  test('INV-46 emoji、组合字符和空文件/EOF 不分割也不归一化', async () => {
    await writeFile(join(root, 'a.txt'), '😀 e\u0301 名字\r\nend')
    await writeFile(join(root, 'empty.txt'), '')
    const { call } = await projectToolFixture({ root })
    const found = await select(call, [
      { path: 'a.txt', match: 'e\u0301' },
      { path: 'a.txt', match: '😀' },
      { path: 'a.txt', match: 'end' },
    ])
    expect(found.targets).toHaveLength(3)
    expect(
      (
        await patch(
          call,
          found.targets.map((item: any, index: number) => ({
            target: item.target,
            text: ['组合', '🙂', '!'][index],
            op: index === 2 ? 'after' : 'replace',
          }))
        )
      ).status
    ).toBe('applied')
    expect(await disk('a.txt')).toBe('🙂 组合 名字\r\nend!')
    const empty = await read(call, 'empty.txt')
    expect((await patch(call, [{ target: empty.target, text: 'first' }])).status).toBe('applied')
    expect(await disk('empty.txt')).toBe('first')
    const source = createProjectSourceCoordinates('😀\r\n')
    const view = {
      path: 'x',
      revision: 'x',
      content: source.content,
      coverage: [{ startOffset: 0, endOffset: 4, startLine: 1, endLine: 1, completeLines: true }],
    }
    expect(() => assertVisibleSpan(view, source, 1, 2)).toThrow('Unicode')
    expect(() => assertVisibleSpan(view, source, 2, 3)).toThrow('CRLF')
  })

  test('INV-47 同文件多处修改使用原始坐标，同点插入保持顺序；重叠未写入且可删一项恢复', async () => {
    const original = 'one\ntwo\nthree\n'
    await writeFile(join(root, 'a.txt'), original)
    const { call } = await projectToolFixture({ root })
    const found = (
      await select(call, [
        { path: 'a.txt', match: 'one' },
        { path: 'a.txt', match: 'three' },
      ])
    ).targets
    const result = await patch(
      call,
      [
        { target: found[0].target, op: 'before', text: 'A\n' },
        { target: found[0].target, op: 'before', text: 'B\n' },
        { target: found[1].target, text: 'THREE LONG\nEXTRA' },
      ],
      'full'
    )
    expect(result.status).toBe('applied')
    expect(result.diff).toContain('THREE LONG')
    expect(await disk('a.txt')).toBe('A\nB\none\ntwo\nTHREE LONG\nEXTRA\n')
    await call('project', 'undo', { changeRef: result.changeRef })
    const whole = await read(call, 'a.txt')
    const overlap = await patch(call, [
      { target: whole.target, text: 'bad\n' },
      { target: found[0].target, text: 'ONE' },
    ])
    expect(overlap.status).toBe('blocked')
    expect(overlap.issues[0].code).toBe('INVALID_INPUT')
    expect(await disk('a.txt')).toBe(original)
    const corrected = await call('project', 'patch', {
      planRef: overlap.planRef,
      amendments: [{ index: 0, edit: null }],
    })
    expect(corrected.status).toBe('applied')
    expect(await disk('a.txt')).toBe('ONE\ntwo\nthree\n')
    expect(
      (await failureOf(call('project', 'patch', { planRef: overlap.planRef, amendments: [] }))).code
    ).toBe('INVALID_INPUT')
  })

  test('INV-48 多个独立引用错误一次汇总，修正错误项即可提交所有正确项', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const { call } = await projectToolFixture({ root })
    const a = await read(call, 'a.txt')
    const b = await read(call, 'b.txt')
    const failed = await patch(call, [
      { target: a.target, text: 'A\n' },
      { target: 'target:00000000', text: 'B\n' },
      { target: 'target:00000001', text: 'C\n' },
    ])
    expect(failed.status).toBe('blocked')
    expect(failed.issues.map((item: any) => item.index)).toEqual([1, 2])
    expect(failed.planRef).toMatch(/^plan:[a-f0-9]{8}$/)
    expect(await disk('a.txt')).toBe('a\n')
    const result = await call('project', 'patch', {
      planRef: failed.planRef,
      amendments: [
        { index: 1, edit: { target: b.target, text: 'B\n' } },
        { index: 2, edit: null },
      ],
    })
    expect(result.status).toBe('applied')
    expect(result.changedFiles).toEqual(['a.txt', 'b.txt'])
    expect(await disk('a.txt')).toBe('A\n')
    expect(await disk('b.txt')).toBe('B\n')
  })

  test('INV-48 校验失败保留未提交计划，修改一项恢复；完整差量与撤销仍可获取', async () => {
    await writeFile(join(root, 'config.json'), '{"enabled":true}\n')
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call } = await projectToolFixture({ root })
    const config = await read(call, 'config.json')
    const a = await read(call, 'a.txt')
    const failed = await patch(call, [
      { target: config.target, text: '{invalid' },
      { target: a.target, text: 'new\n' },
    ])
    expect(failed.status).toBe('blocked')
    expect(failed.issues[0].code).toBe('VALIDATION_FAILED')
    expect(await disk('config.json')).toBe('{"enabled":true}\n')
    expect(await disk('a.txt')).toBe('old\n')
    const fixed = await call('project', 'patch', {
      planRef: failed.planRef,
      amendments: [{ index: 0, edit: { target: config.target, text: '{"enabled":false}\n' } }],
    })
    expect(fixed.status).toBe('applied')
    expect((await call('project', 'inspect', { changeRef: fixed.changeRef })).diff).toContain(
      'false'
    )
    await call('project', 'undo', { changeRef: fixed.changeRef })
    expect(await disk('config.json')).toBe('{"enabled":true}\n')
    expect(await disk('a.txt')).toBe('old\n')
  })

  test('INV-49 二十文件、一千处编辑每文件一个补丁，摘要不携带源码；一次撤销全部恢复', async () => {
    const files = Array.from({ length: 20 }, (_, n) => `f${n}.txt`)
    const original = `${Array.from({ length: 50 }, (_, n) => `value-${n};`).join('\n')}\n`
    await Promise.all(files.map((path) => writeFile(join(root, path), original)))
    const { call, kernel } = await projectToolFixture({ root })
    const found = await select(
      call,
      files.flatMap((path) =>
        Array.from({ length: 50 }, (_, n) => ({ path, match: `value-${n};` }))
      )
    )
    expect(found.issues).toBeUndefined()
    expect(found.targets).toHaveLength(1000)
    const result = await patch(
      call,
      found.targets.map((item: any) => ({
        target: item.target,
        text: item.text.replace('value-', 'changed-'),
      }))
    )
    expect(result.status).toBe('applied')
    expect(result.changedFiles).toHaveLength(20)
    expect(kernel.getTransaction(result.transactionId)?.patches).toHaveLength(20)
    expect(JSON.stringify(result).length).toBeLessThan(5000)
    for (const path of files)
      expect(await disk(path)).toBe(original.replaceAll('value-', 'changed-'))
    await call('project', 'undo', { changeRef: result.changeRef })
    for (const path of files) expect(await disk(path)).toBe(original)
  })

  test('取消保持取消错误和原文，不返回可误解的 blocked；边界上限明确失败', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const fixture = await projectToolFixture({ root })
    const window = await read(fixture.call, 'a.txt')
    const abort = new AbortController()
    abort.abort()
    await expect(
      projectFileOperations.patch(
        { edits: [{ target: window.target, text: 'new' }] },
        { ...fixture.context, abortSignal: abort.signal }
      )
    ).rejects.toThrow()
    expect(await disk('a.txt')).toBe('old\n')
    expect(
      (await failureOf(select(fixture.call, Array(1001).fill({ path: 'a.txt', match: 'old' }))))
        .code
    ).toBe('INVALID_INPUT')
    await writeFile(join(root, 'many.txt'), 'word '.repeat(21))
    const tooMany = await select(fixture.call, [{ path: 'many.txt', match: 'word' }])
    expect(tooMany.issues[0].code).toBe('SCOPE_VIOLATION')
    expect(tooMany.issues[0].candidates).toBeUndefined()
  })

  test('解析定位不能拆开 CRLF 的下标，结构选择也不经 UTF-8 字节转换', () => {
    const source = '# 😀\r\ndef load():\r\n    return 1\r\n'
    const [span] = projectStructureSpans('a.py', source)
    expect(source.slice(span.start, span.end)).toBe('def load():\r\n    return 1\r\n')
  })
})
