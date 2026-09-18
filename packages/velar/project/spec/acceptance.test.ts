/**
 * 两件项目工具（`velar:project`、`velar:code`）与项目内核的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 改动或删除已有用例要在差量报告里点名并说明理由。这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 一律经代码面的能力端口调（和模型的程序是同一条路），断言程序看得到的 code 与 message。
 * 项目空间的装配与三件共用能力的项目端口在 `@velaros-ai/project` 的验收里测。
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { codeProgramChecker } from '@velaros-ai/code-surface'

import { VelarCodeModule, VelarProjectModule } from '../contracts'
import { ProjectExecutionGate } from '../impl/operations/ProjectExecutionGate'
import { createSecretRedactionProvider } from '../index'

import { createProjectHarness, failureOf } from './support'

/** UTF-8 的 BOM。 */
const Bom = String.fromCharCode(0xfeff)

/** 生成的声明所在的目录。 */
const Baselines = resolve(import.meta.dir, '../../../../baselines/code-surface')

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-acceptance-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('模型面', () => {
  test('INV-1 velar:project 的六个操作与 velar:code 的两个，声明从源码生成、只放出这些；随包发布的声明与生成物同一份，放出的方法就是能调的那些', async () => {
    const { operations } = await createProjectHarness(root)
    expect(Object.keys(operations.project).sort()).toEqual(['edit', 'inspect', 'list', 'read', 'search', 'undo'])
    expect(Object.keys(operations.code).sort()).toEqual(['analyze', 'query'])
    const project = await readFile(join(Baselines, 'project.d.ts'), 'utf8')
    const code = await readFile(join(Baselines, 'code.d.ts'), 'utf8')
    const functions = (text: string) => [...text.matchAll(/export function (\w+)\(/g)].map((match) => match[1]).sort()
    expect(functions(project)).toEqual(['edit', 'inspect', 'list', 'read', 'search', 'undo'])
    expect(functions(code)).toEqual(['analyze', 'query'])
    // 调用上下文与空间端口不进模型面：它们的名字一个都不出现在声明里。
    for (const text of [project, code]) {
      expect(text).not.toContain('ProjectOperationContext')
      expect(text).not.toContain('ProjectSpacePort')
    }
    for (const [surface, table] of [[VelarProjectModule, operations.project], [VelarCodeModule, operations.code]] as const) {
      expect(surface.specifier).toBe(`velar:${surface.namespace}`)
      expect(surface.declarations).toBe(await readFile(join(Baselines, `${surface.namespace}.d.ts`), 'utf8'))
      expect([...surface.methods].sort()).toEqual(Object.keys(table).sort())
    }
  })

  test('INV-22 两份代码模版整份照生成的声明过类型检查；它们不嵌进声明，随模型面发布的就是这两份文件', async () => {
    for (const [surface, file] of [[VelarProjectModule, 'template.js'], [VelarCodeModule, 'code-template.js']] as const) {
      const declarations = await readFile(join(Baselines, `${surface.namespace}.d.ts`), 'utf8')
      const template = await readFile(resolve(import.meta.dir, '..', file), 'utf8')
      const checked = codeProgramChecker.check({ source: template, granted: [{ namespace: surface.namespace, declarations }] })
      expect({ file, diagnostics: checked.ok ? [] : checked.diagnostics }).toEqual({ file, diagnostics: [] })
      expect(surface.template).toBe(template.trim())
      expect(declarations).not.toContain('的代码模版')
    }
  })
})

describe('编辑的边界', () => {
  test('INV-2 fileRef 只覆盖程序拿到的那几行，range 越出去整批拒绝、文件不变', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('a.txt', 2)
    expect(view.fileRef).toStartWith('view:')
    expect(view.lines).toEqual([[2, 'second']])
    const failure = await failureOf(call('project', 'edit', { steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', range: 3, text: 'bad' }] }] }))
    expect(failure.code).toBe('SCOPE_VIOLATION')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nsecond\nthird\n')
  })

  test('INV-3 读取之后被外部改过，基于旧版本的编辑整批拒绝，不覆盖外部改动', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('a.txt')
    await writeFile(join(root, 'a.txt'), 'one\nchanged outside\n')
    const failure = await failureOf(call('project', 'edit', { steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', range: 2, text: 'mine' }] }] }))
    expect(failure.code).toBe('BASE_REVISION_MISMATCH')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\nchanged outside\n')
  })

  test('INV-4 一次 edit 是一个事务：一处定不下来就全不改，message 点名是第几步第几处', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n')
    const { call, read } = await createProjectHarness(root)
    const a = await read('a.txt')
    const b = await read('b.txt')
    const failure = await failureOf(call('project', 'edit', { steps: [
      { action: 'edit', fileRef: a.fileRef, edits: [{ op: 'replace', range: 1, text: 'ALPHA' }] },
      { action: 'edit', fileRef: b.fileRef, edits: [{ op: 'replace', match: 'not in the file', text: 'x' }] },
    ] }))
    expect(failure.code).toBe('TARGET_NOT_FOUND')
    expect(failure.message).toContain('steps[1]')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta\n')
  })

  test('INV-5 撤销遇到之后的外部修改拒绝覆盖；撤过的再撤一次是幂等成功', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call, read } = await createProjectHarness(root)
    const edited = await call('project', 'edit', { steps: [{ action: 'edit', fileRef: (await read('a.txt')).fileRef, edits: [{ op: 'replace', range: 1, text: 'two' }] }] })
    expect(edited.changeRef).toStartWith('change:')
    await writeFile(join(root, 'a.txt'), 'three\n')
    expect((await failureOf(call('project', 'undo', { changeRef: edited.changeRef }))).code).toBe('CONFLICT_WITH_EXTERNAL_EDIT')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three\n')

    await writeFile(join(root, 'b.txt'), 'b1\n')
    const second = await call('project', 'edit', { steps: [{ action: 'edit', fileRef: (await read('b.txt')).fileRef, edits: [{ op: 'replace', range: 1, text: 'b2' }] }] })
    await call('project', 'undo', { changeRef: second.changeRef })
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b1\n')
    expect(await call('project', 'undo', { changeRef: second.changeRef })).toMatchObject({ alreadyUndone: true })
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b1\n')
  })

  test('INV-6 越出项目的路径一律拒绝，包括经符号链接指到项目外', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'project-acceptance-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside\n')
      await symlink(outside, join(root, 'link'))
      const { call } = await createProjectHarness(root)
      expect((await failureOf(call('project', 'read', { files: [{ path: '../secret.txt' }] }))).code).toBe('PERMISSION_DENIED')
      expect((await failureOf(call('project', 'read', { files: [{ path: 'link/secret.txt' }] }))).code).toBe('PERMISSION_DENIED')
      expect((await failureOf(call('project', 'edit', { steps: [{ action: 'create', path: 'link/new.txt', text: 'x\n' }] }))).code).toBe('PERMISSION_DENIED')
      await expect(readFile(join(outside, 'new.txt'))).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-9 文本改动保留原来的 BOM 与换行，没改到的字节不动；新建文件是无 BOM 的 UTF-8、LF', async () => {
    await writeFile(join(root, 'crlf.txt'), Buffer.from(`${Bom}one\r\ntwo\r\nthree\r\n`, 'utf8'))
    const { call, read } = await createProjectHarness(root)
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: (await read('crlf.txt')).fileRef, edits: [{ op: 'replace', range: 2, text: 'TWO' }] }] })
    expect([...await readFile(join(root, 'crlf.txt'))]).toEqual([...Buffer.from(`${Bom}one\r\nTWO\r\nthree\r\n`, 'utf8')])
    await call('project', 'edit', { steps: [{ action: 'create', path: 'fresh.txt', text: 'a\nb\n' }] })
    expect([...await readFile(join(root, 'fresh.txt'))]).toEqual([...Buffer.from('a\nb\n', 'utf8')])
  })

  test('INV-13 同一个物理文件的项目内别名算同一个文件：一次编辑里出现两次整批拒绝，拒读名单按真实路径判', async () => {
    await writeFile(join(root, 'real.txt'), 'L1\nL2\n')
    await symlink('real.txt', join(root, 'link.txt'))
    const { call, read } = await createProjectHarness(root)
    const linkView = await read('link.txt')
    const realView = await read('real.txt')
    const failure = await failureOf(call('project', 'edit', { steps: [
      { action: 'edit', fileRef: linkView.fileRef, edits: [{ op: 'replace', range: 1, text: 'A' }] },
      { action: 'edit', fileRef: realView.fileRef, edits: [{ op: 'replace', range: 2, text: 'B' }] },
    ] }))
    expect(failure.code).toBe('INVALID_INPUT')
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('L1\nL2\n')

    await writeFile(join(root, '.env'), 'API_KEY=sk-live-SECRET\n')
    await symlink('.env', join(root, 'env.sample'))
    const denied = await createProjectHarness(root, { corePolicy: { readDeny: ['.env'] } })
    expect((await failureOf(denied.call('project', 'read', { files: [{ path: '.env' }] }))).code).toBe('PERMISSION_DENIED')
    expect((await failureOf(denied.call('project', 'read', { files: [{ path: 'env.sample' }] }))).code).toBe('PERMISSION_DENIED')
  })

  test('INV-14 版本库内部缺省不许写，报错说清楚要用命令跑 git', async () => {
    const { call } = await createProjectHarness(root)
    const failure = await failureOf(call('project', 'edit', { steps: [{ action: 'create', path: '.git/hooks/pre-commit', text: '#!/bin/sh\n' }] }))
    expect(failure.code).toBe('PERMISSION_DENIED')
    expect(failure.message).toContain('velar:shell')
    await expect(readFile(join(root, '.git/hooks/pre-commit'))).rejects.toThrow()
  })

  test('INV-10 命中 generatedFiles 的文件不许手改，下一步是改生成器的输入再重新生成', async () => {
    const { call } = await createProjectHarness(root)
    const failure = await failureOf(call('project', 'edit', { steps: [{ action: 'create', path: 'src/api.generated.ts', text: 'export {}\n' }] }))
    expect(failure.code).toBe('GENERATED_FILE')
    expect(failure.message).toContain('生成')
    await expect(readFile(join(root, 'src/api.generated.ts'))).rejects.toThrow()
  })

  test('INV-18 文件在读完之后被改过、原来要改的地方还唯一时，message 给出新行号与新 fileRef，换上它重提就成', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('a.ts')
    await writeFile(join(root, 'a.ts'), '// header\nconst a = 1\nconst b = 2\nconst c = 3\n')
    const failure = await failureOf(call('project', 'edit', { steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', range: 2, match: 'b = 2', text: 'b = 20' }] }] }))
    expect(failure.code).toBe('BASE_REVISION_MISMATCH')
    expect(failure.message).toContain('第 3 行')
    const fresh = /view:[a-f0-9]{64}/.exec(failure.message)?.[0]
    expect(fresh).toBeDefined()
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: fresh, edits: [{ op: 'replace', range: 3, match: 'b = 2', text: 'b = 20' }] }] })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('// header\nconst a = 1\nconst b = 20\nconst c = 3\n')
  })

  test('INV-19 读出来被遮住的内容只能看不能改：窗口标 redacted、不给 fileRef', async () => {
    // 假密钥拼出来写：源码里写成整串，公开前的扫描会把它当成真的 API key。
    const fakeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
    await writeFile(join(root, 'config.ts'), `export const key = "${fakeKey}"\n`)
    const { read } = await createProjectHarness(root, { providers: { secretRedaction: createSecretRedactionProvider() } })
    const view = await read('config.ts')
    expect(view.redacted).toBe(true)
    expect(view.fileRef).toBeUndefined()
    expect(view.editable).toBe(false)
    expect(JSON.stringify(view.lines)).not.toContain(fakeKey)
  })

  test('INV-20 程序看得到的只有 code 与 message：定位不唯一时 message 里有位置、候选与下一步', async () => {
    await writeFile(join(root, 'dup.txt'), 'same\nother\nsame\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('dup.txt')
    const failure = await failureOf(call('project', 'edit', { steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', match: 'same', text: 'x' }] }] }))
    expect(failure.code).toBe('AMBIGUOUS_TARGET')
    expect(failure.message).toContain('steps[0].edits[0]')
    expect(failure.message).toContain('候选')
    expect(failure.message).toContain('下一步')
  })

  test('INV-23 行号照 wc -l 数：结尾换行之后那个零宽的行不给模型看，读到最后一行就是读到头，末尾照样插得进去', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n\n')
    const { call, read } = await createProjectHarness(root)
    const whole = await read('a.txt')
    expect(whole.lines).toEqual([[1, 'one'], [2, 'two'], [3, '']])
    expect(whole.totalLines).toBe(3)
    // 范围停在一个空行上，那一行照样交出来；读到了最后一行，就没有续读。
    const ranged = await read('a.txt', [2, 3])
    expect(ranged.lines).toEqual([[2, 'two'], [3, '']])
    expect(ranged.hasMore).toBeUndefined()
    expect(ranged.continuation).toBeUndefined()
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: ranged.fileRef, edits: [{ op: 'insert', at: 'end', text: 'four' }] }] })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n\nfour\n')
    // 空文件是 0 行；越出行数的行号报出文件实际有几行，并指向在末尾插入的写法。
    await writeFile(join(root, 'empty.txt'), '')
    const empty = await read('empty.txt')
    expect(empty.lines).toEqual([])
    expect(empty.totalLines).toBe(0)
    const current = await read('a.txt')
    const beyond = await failureOf(call('project', 'edit', { steps: [{ action: 'edit', fileRef: current.fileRef, edits: [{ op: 'replace', range: 9, text: 'x' }] }] }))
    expect(beyond.message).toContain('第 9 行超出了文件的行数（4 行）')
    expect(beyond.message).toContain("at: 'end'")
  })
})

describe('授权与资源门', () => {
  test('INV-17 修改授权带着这次要写的文件问，而且问在规划之后、写盘之前', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const harness = await createProjectHarness(root)
    const file = await harness.read('a.txt')
    await harness.call('project', 'edit', { steps: [
      { action: 'create', path: 'created.txt', text: 'new\n' },
      { action: 'edit', fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'ALPHA' }] },
    ] })
    // 先规划、再带着路径问授权：确认卡片列得出这次会写哪些文件。
    expect(harness.mutations).toEqual(['改项目文件'])
    expect([...harness.authorizedPaths[0]!].sort()).toEqual(['a.txt', 'created.txt'])
  })

  test('INV-8 同一项目根上写串行、读并发；排队的写者不被后来的读者饿死；取消了的等待者不运行', async () => {
    const gate = new ProjectExecutionGate()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstRead = gate.run('/repo', false, new AbortController().signal, () => new Promise<void>((done) => { order.push('read-1 start'); releaseFirst = done }))
    const secondRead = gate.run('/repo', false, new AbortController().signal, async () => { order.push('read-2') })
    await secondRead
    const writer = gate.run('/repo', true, new AbortController().signal, async () => { order.push('write') })
    const lateRead = gate.run('/repo', false, new AbortController().signal, async () => { order.push('read-3') })
    const abort = new AbortController()
    const cancelled = gate.run('/repo', true, abort.signal, async () => { order.push('cancelled') })
    abort.abort()
    releaseFirst()
    await Promise.all([firstRead, writer, lateRead, cancelled.catch(() => undefined)])
    expect(order).toEqual(['read-1 start', 'read-2', 'write', 'read-3'])
  })
})
