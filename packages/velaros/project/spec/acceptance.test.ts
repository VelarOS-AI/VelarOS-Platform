/**
 * 两件项目工具（`velaros:project`、`velaros:code`）、项目内核与项目给共用能力装的端口（`projectCapabilityPorts`）的验收测试：
 * 每一条对应 spec/invariants.md 里的一个编号。
 * 改动或删除已有用例要在差量报告里点名并说明理由。这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 一律经代码面的能力端口调（和模型的程序是同一条路），断言程序看得到的 code 与 message。
 * 共用能力（`velaros:shell`、`velaros:sandbox`、`velaros:images`）用的是它们真实的操作，只有宿主是假的（INV-26～INV-29）。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { codeProgramChecker } from '@velaros-ai/script'

import { ProjectCodeLimits, ProjectFileLimits, ProjectPolicyDefaults, VelarCodeModule, VelarProjectModule } from '../contracts'
import { ProjectExecutionGate } from '../impl/operations/ProjectExecutionGate'

import { commandResult, createProjectHarness, createProjectPortsHarness, failureOf, fakeSandboxHost, pngHeader } from './support'

/** UTF-8 的 BOM。 */
const Bom = String.fromCharCode(0xfeff)

/** 生成的声明所在的目录。 */
const Baselines = resolve(import.meta.dir, '../../../../baselines/script')

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-acceptance-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('模型面', () => {
  test('INV-1 velaros:project 的六个操作与 velaros:code 的两个，声明从源码生成、只放出这些；随包发布的声明与生成物同一份，放出的方法就是能调的那些', async () => {
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
      expect(surface.specifier).toBe(`velaros:${surface.namespace}`)
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

  test('INV-13 同一个物理文件的项目内别名算同一个文件：一次编辑里出现两次整批拒绝；宿主的列举过滤器按真实路径判、只管列举', async () => {
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

    await writeFile(join(root, '.env'), 'API_KEY=local\n')
    await symlink('.env', join(root, 'env.sample'))
    const filtered = await createProjectHarness(root, { providers: { fileFilter: { shouldInclude: ({ path }) => path !== '.env' } } })
    const listed = (await filtered.call('project', 'list', {})).entries.map((entry: { path: string }) => entry.path)
    expect(listed).toContain('real.txt')
    expect(listed).not.toContain('.env')
    expect(listed).not.toContain('env.sample')
    expect((await filtered.read('.env')).lines).toEqual([[1, 'API_KEY=local']])
  })

  test('INV-14 没有读写名单：.git 里的、.env 这类照常能读能写，只受根内约束', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true })
    await writeFile(join(root, '.git', 'info', 'exclude'), '# local\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('.git/info/exclude')
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'insert', range: 1, side: 'after', text: 'scratch/' }] }] })
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe('# local\nscratch/\n')
  })

  test('INV-10 没有生成文件名单：生成出来的文件也改得动', async () => {
    const { call } = await createProjectHarness(root)
    await call('project', 'edit', { steps: [{ action: 'create', path: 'src/api.generated.ts', text: 'export {}\n' }] })
    expect(await readFile(join(root, 'src/api.generated.ts'), 'utf8')).toBe('export {}\n')
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

  test('INV-19 读出来的就是原文：像密钥的片段不遮，窗口照常签发 fileRef、能改', async () => {
    // 假密钥拼出来写：源码里写成整串，公开前的扫描会把它当成真的 API key。
    const fakeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
    await writeFile(join(root, 'config.ts'), `export const key = "${fakeKey}"\n`)
    const { call, read } = await createProjectHarness(root)
    const view = await read('config.ts')
    expect(view.lines).toEqual([[1, `export const key = "${fakeKey}"`]])
    expect(view.editable).toBeUndefined()
    await call('project', 'edit', { steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', range: 1, text: 'export const key = process.env.KEY' }] }] })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe('export const key = process.env.KEY\n')
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
    // 范围停在一个空行上，那一行照样交出来。
    const ranged = await read('a.txt', [2, 3])
    expect(ranged.lines).toEqual([[2, 'two'], [3, '']])
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

describe('不折叠', () => {
  test('INV-24 read、list、search、edit、inspect 交回全部，看多少由程序定；只有守内存的上限，超了明说', async () => {
    const long = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`)
    await writeFile(join(root, 'long.txt'), `${long.join('\n')}\n`)
    await mkdir(join(root, 'a/b/c/d/e'), { recursive: true })
    await writeFile(join(root, 'a/b/c/d/e/leaf.txt'), 'leaf\n')
    for (let index = 0; index < 150; index++) await writeFile(join(root, `a/hit-${index}.txt`), `before\nneedle ${index}\nafter\n`)
    const { call, read, kernel } = await createProjectHarness(root)

    // 不给 range 就是整个文件：三千行都在，没有续读。
    const whole = await read('long.txt')
    expect(whole.lines).toHaveLength(3000)
    expect(whole).not.toHaveProperty('continuation')
    // 不给 depth 就是整棵树：第五层的文件也在，没有分页。
    const listed = await call('project', 'list', { path: 'a' })
    expect(listed.entries.map((entry: { path: string }) => entry.path)).toContain('a/b/c/d/e/leaf.txt')
    expect(Object.keys(listed)).toEqual(['entries'])
    // 全部命中，每个命中的文件一个能直接改的窗口。
    const searched = await call('project', 'search', { query: 'needle' })
    expect(searched.hits).toHaveLength(150)
    expect(searched.files).toHaveLength(150)
    expect(searched.files.every((window: { fileRef?: string }) => window.fileRef?.startsWith('view:'))).toBe(true)
    // 差量是完整的：整份换掉三千行，每一行都在 diff 里，inspect 给的是同一份。
    const edited = await call('project', 'edit', { steps: [{ action: 'overwrite', fileRef: whole.fileRef, text: `${long.map((line) => `${line}!`).join('\n')}\n` }] })
    expect(edited.diff).toContain('+line 3000!')
    expect(edited).not.toHaveProperty('diffTruncated')
    expect((await call('project', 'inspect', { changeRef: edited.changeRef })).diff).toBe(edited.diff)

    // 守内存的上限：超了整个失败并说清怎么收窄，不交回一部分。
    kernel.search = async (input) => ({ query: input.query, hits: [], truncated: true, diagnostics: ['ripgrep 搜索超过 120000 毫秒超时'] })
    const search = await failureOf(call('project', 'search', { query: 'needle' }))
    expect(search.code).toBe('SCOPE_VIOLATION')
    expect(search.message).toContain('收窄')
    kernel.listFiles = async (input) => Array.from({ length: input?.maxFiles ?? 0 }, (_, index) => ({ path: `f${index}`, type: 'file' as const }))
    const list = await failureOf(call('project', 'list', {}))
    expect(list.code).toBe('SCOPE_VIOLATION')
    expect(list.message).toContain(String(ProjectFileLimits.listEntries))
  }, 60_000)

  test('INV-25 声明里写给模型的上限就是常量表里的数', () => {
    const project = VelarProjectModule.declarations
    for (const phrase of [
      `一次最多 ${ProjectFileLimits.readFiles} 个`,
      `不超过 ${ProjectFileLimits.readChars} 字符`,
      `各最多 ${ProjectFileLimits.patterns} 条`,
      `数字最多 ${ProjectFileLimits.listDepth}`,
      `超过 ${ProjectFileLimits.listEntries} 条`,
      `超过 ${ProjectFileLimits.searchHits} 处`,
      `缺省 ${ProjectFileLimits.searchContextLinesDefault}、最多 ${ProjectFileLimits.searchContextLines}`,
      `一次最多 ${ProjectFileLimits.steps} 步`,
      `展开后一次最多 ${ProjectFileLimits.recodePaths} 个`,
      `缺省最多改 ${ProjectPolicyDefaults.maxChangedFilesPerTransaction} 个文件`,
    ]) expect(project, phrase).toContain(phrase)
    const code = VelarCodeModule.declarations
    for (const phrase of [
      `最多 ${ProjectCodeLimits.extensions} 个`,
      `0–${ProjectCodeLimits.scanDepth}`,
      `超过 ${ProjectCodeLimits.results} 条`,
    ]) expect(code, phrase).toContain(phrase)
  })
})

describe('不问人，只排队', () => {
  test('INV-17 改动与撤销不问人：上下文里没有审批端口、空间端口里没有授权口子，编辑、撤销照样做完', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const harness = await createProjectHarness(root)
    expect(Object.keys(harness.context).sort()).toEqual(['abortSignal', 'project', 'sessionId'])
    const file = await harness.read('a.txt')
    const edited = await harness.call('project', 'edit', { steps: [
      { action: 'create', path: 'created.txt', text: 'new\n' },
      { action: 'edit', fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'ALPHA' }] },
    ] })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    await harness.call('project', 'undo', { changeRef: edited.changeRef })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    await expect(readFile(join(root, 'created.txt'))).rejects.toThrow()
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

describe('共用能力的项目端口', () => {
  test('INV-26 项目里的危险命令每次都由用户亲自确认；被拒一个进程都不起；别的命令（会改项目的、长驻的也一样）不问，直接跑，输出原样交回', async () => {
    const denied = await createProjectPortsHarness(root, { approve: false })
    expect((await failureOf(denied.call('shell', 'run', { command: 'rm -rf ./dist' }))).code).toBe('PERMISSION')
    expect(denied.runs).toEqual([])
    expect(denied.confirmations).toHaveLength(1)
    expect(denied.confirmations[0]?.options).toMatchObject({ approvalRisk: 'high', requireManualApproval: true, rememberRiskScope: false, riskScope: 'project-command:dangerous' })
    expect(denied.confirmations[0]?.message).toContain('当前项目')

    // 用户点了头：宿主收到的是「已确认的危险命令」。
    const approved = await createProjectPortsHarness(root)
    await approved.call('shell', 'run', { command: 'rm -rf ./dist' })
    expect(approved.runs.map(({ command, allowDangerous }) => ({ command, allowDangerous }))).toEqual([{ command: 'rm -rf ./dist', allowDangerous: true }])

    // 会改项目的、长驻的都不问（审批端口会拒，也一次都没被叫到）；输出原样交回，像密钥的片段也不遮。
    const secret = ['sk', 'live', '0123456789abcdefghijklmnopqrstuvwxyz'].join('-')
    const quiet = await createProjectPortsHarness(root, {
      approve: false,
      runCommand: async (command, options) => commandResult(command, options?.cwd ?? root, { stdout: `key=${secret}` }),
    })
    for (const command of ['touch created.txt', 'npm run dev', 'ls']) expect((await quiet.call('shell', 'run', { command })).stdout).toBe(`key=${secret}`)
    expect(quiet.confirmations).toEqual([])
    expect(quiet.runs.map(({ command, options }) => [command, options?.background])).toEqual([['touch created.txt', false], ['npm run dev', true], ['ls', false]])
  })

  test('INV-27 命令的工作目录与沙箱的源目录按真实路径钳在项目之内：出了项目（含经符号链接指到外面）在问用户之前就拒绝，一个进程都不起、什么都不镜像', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'project-acceptance-outside-'))
    await mkdir(join(root, 'src'))
    await symlink(outside, join(root, 'escape'))
    const sandbox = fakeSandboxHost(root)
    try {
      const harness = await createProjectPortsHarness(root, { sandbox: sandbox.host })
      for (const where of ['..', outside, 'escape', 'escape/deeper']) {
        const refused = await failureOf(harness.call('shell', 'run', { command: 'rm -rf build', cwd: where }))
        expect({ where, code: refused.code }).toEqual({ where, code: 'PERMISSION' })
        expect(refused.message).toContain('项目之内')
        const mirrored = await failureOf(harness.call('sandbox', 'create', { source: where }))
        expect({ where, code: mirrored.code }).toEqual({ where, code: 'PERMISSION' })
      }
      expect(harness.confirmations).toEqual([])
      expect(harness.runs).toEqual([])
      expect(sandbox.calls).toEqual([])
      // 项目里的照常：工作目录与源目录交给宿主时是解析好的绝对路径。
      await harness.call('shell', 'run', { command: 'ls', cwd: 'src' })
      expect(harness.runs[0]?.options?.cwd).toBe(join(root, 'src'))
      expect(await harness.call('sandbox', 'create', { source: 'src' })).toMatchObject({ source: join(root, 'src') })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-28 演练沙箱落回不问人、不按名单拦：点名的路径核过就把同一份差量的指纹交给宿主落回，点名了没变化的就拒绝；镜像里命令的输出原样交回', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    const sandbox = fakeSandboxHost(root, { stdout: `${secret}\n`, diff: { created: ['src/api.generated.ts'], modified: ['notes.txt', '.env'], deleted: ['deploy.key'], fingerprint: 'fp' } })
    const { call, confirmations } = await createProjectPortsHarness(root, { sandbox: sandbox.host, approve: false })
    const applied = await call('sandbox', 'apply', { id: 'sb' })
    expect(applied).toMatchObject({ created: ['src/api.generated.ts'], modified: ['notes.txt', '.env'], deleted: ['deploy.key'] })
    expect(sandbox.calls.at(-1)).toEqual({ apply: { sandboxId: 'sb', fingerprint: 'fp' } })
    const unknown = await failureOf(call('sandbox', 'apply', { id: 'sb', paths: ['never-changed.txt'] }))
    expect(unknown.code).toBe('VALIDATION')
    expect(unknown.message).toContain('never-changed.txt')
    expect(sandbox.calls.filter((entry) => 'apply' in entry)).toHaveLength(1)
    expect((await call('sandbox', 'run', { id: 'sb', command: 'cat .env' })).stdout).toBe(`${secret}\n`)
    // 审批端口会拒，却一次都没被叫到：落回与不危险的命令都不问人。
    expect(confirmations).toEqual([])
  })

  test('INV-29 项目里看图只看项目里的图：出了项目（含经符号链接指到外面）的那一张 PERMISSION，项目里的都照常交给模型', async () => {
    await writeFile(join(root, 'shot.png'), pngHeader(40, 30))
    await writeFile(join(root, '.env.png'), pngHeader(10, 10))
    const outside = await mkdtemp(join(tmpdir(), 'project-acceptance-image-'))
    try {
      await writeFile(join(outside, 'far.png'), pngHeader(10, 10))
      await symlink(join(outside, 'far.png'), join(root, 'link.png'))
      const { call, attachments } = await createProjectPortsHarness(root)
      const seen = await call('images', 'view', { files: [{ path: 'shot.png' }, { path: '.env.png' }, { path: 'link.png' }] })
      expect(seen.files).toMatchObject([
        { path: 'shot.png', width: 40, height: 30 },
        { path: '.env.png', width: 10 },
        { path: 'link.png', error: { code: 'PERMISSION' } },
      ])
      expect(attachments).toHaveLength(2)
      expect((await failureOf(call('images', 'view', { files: [{ path: join(outside, 'far.png') }] }))).code).toBe('PERMISSION')
      expect(attachments).toHaveLength(2)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
