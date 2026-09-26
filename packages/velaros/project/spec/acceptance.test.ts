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

import {
  ProjectCodeLimits,
  ProjectFileLimits,
  ProjectPolicyDefaults,
  VelarCodeModule,
  VelarProjectModule,
} from '../contracts'
import { ProjectExecutionGate } from '../impl/operations/ProjectExecutionGate'

import {
  commandResult,
  createProjectHarness,
  createProjectPortsHarness,
  failureOf,
  fakeSandboxHost,
  pngHeader,
} from './support'

/** UTF-8 的 BOM。 */
const Bom = String.fromCharCode(0xfeff)

/** 生成的声明所在的目录。 */
const Baselines = resolve(import.meta.dir, '../../../../baselines/script')

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-acceptance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('模型面', () => {
  test('INV-1 velaros:project 的六个操作与 velaros:code 的两个，声明从源码生成、只放出这些；随包发布的声明与生成物同一份，放出的方法就是能调的那些', async () => {
    const { operations } = await createProjectHarness(root)
    expect(Object.keys(operations.project).sort()).toEqual([
      'edit',
      'inspect',
      'list',
      'read',
      'search',
      'undo',
    ])
    expect(Object.keys(operations.code).sort()).toEqual(['analyze', 'query'])
    const project = await readFile(join(Baselines, 'project.d.ts'), 'utf8')
    const code = await readFile(join(Baselines, 'code.d.ts'), 'utf8')
    const functions = (text: string) =>
      [...text.matchAll(/export function (\w+)\(/g)].map((match) => match[1]).sort()
    expect(functions(project)).toEqual(['edit', 'inspect', 'list', 'read', 'search', 'undo'])
    expect(functions(code)).toEqual(['analyze', 'query'])
    // 调用上下文与空间端口不进模型面：它们的名字一个都不出现在声明里。
    for (const text of [project, code]) {
      expect(text).not.toContain('ProjectOperationContext')
      expect(text).not.toContain('ProjectSpacePort')
    }
    for (const [surface, table] of [
      [VelarProjectModule, operations.project],
      [VelarCodeModule, operations.code],
    ] as const) {
      expect(surface.specifier).toBe(`velaros:${surface.namespace}`)
      expect(surface.declarations).toBe(
        await readFile(join(Baselines, `${surface.namespace}.d.ts`), 'utf8')
      )
      expect([...surface.methods].sort()).toEqual(Object.keys(table).sort())
    }
  })

  test('INV-22 两份代码模版整份照生成的声明过类型检查；它们不嵌进声明，随模型面发布的就是这两份文件', async () => {
    for (const [surface, file] of [
      [VelarProjectModule, 'template.js'],
      [VelarCodeModule, 'code-template.js'],
    ] as const) {
      const declarations = await readFile(join(Baselines, `${surface.namespace}.d.ts`), 'utf8')
      const template = await readFile(resolve(import.meta.dir, '..', file), 'utf8')
      const checked = codeProgramChecker.typecheck({
        source: template,
        granted: [{ namespace: surface.namespace, declarations }],
      })
      expect({ file, diagnostics: checked.ok ? [] : checked.diagnostics }).toEqual({
        file,
        diagnostics: [],
      })
      expect(surface.template).toBe(template.trim())
      expect(declarations).not.toContain('的代码模版')
    }
  })
})

describe('编辑的边界', () => {
  test('INV-2 编辑按路径写：write 整份写入（没有就新建），replace 把唯一的一段原文换掉；同一个文件接连几步，后一步按前一步改完的算', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call } = await createProjectHarness(root)
    await call('project', 'edit', {
      steps: [
        { action: 'replace', path: 'a.txt', oldText: 'second', newText: 'SECOND' },
        { action: 'write', path: 'nested/b.txt', text: 'new file\n' },
      ],
    })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nSECOND\nthird\n')
    expect(await readFile(join(root, 'nested/b.txt'), 'utf8')).toBe('new file\n')
    await call('project', 'edit', {
      steps: [
        { action: 'write', path: 'a.txt', text: 'whole\n' },
        { action: 'replace', path: 'a.txt', oldText: 'whole', newText: 'one' },
        { action: 'replace', path: 'a.txt', oldText: 'one', newText: 'two' },
      ],
    })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n')
  })

  test('INV-3 按路径的改动作用在提交那一刻的内容上：读取之后外部改了别处照样保住；要换的原文被外部改没了就一个字都不写', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    const { call, read } = await createProjectHarness(root)
    expect((await read('a.txt')).text).toBe('one\ntwo\n')
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nadded outside\n')
    await call('project', 'edit', {
      steps: [{ action: 'replace', path: 'a.txt', oldText: 'two', newText: 'mine' }],
    })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\nmine\nadded outside\n')
    await writeFile(join(root, 'a.txt'), 'rewritten outside\n')
    const failure = await failureOf(
      call('project', 'edit', {
        steps: [{ action: 'replace', path: 'a.txt', oldText: 'mine', newText: 'again' }],
      })
    )
    expect(failure.code).toBe('TARGET_NOT_FOUND')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('rewritten outside\n')
  })

  test('INV-4 一次 edit 是一个事务：一处定不下来就全不改，message 点名是第几步', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n')
    const { call } = await createProjectHarness(root)
    const failure = await failureOf(
      call('project', 'edit', {
        steps: [
          { action: 'replace', path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' },
          { action: 'replace', path: 'b.txt', oldText: 'not in the file', newText: 'x' },
        ],
      })
    )
    expect(failure.code).toBe('TARGET_NOT_FOUND')
    expect(failure.message).toContain('steps[1]')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta\n')
  })

  test('INV-5 撤销遇到之后的外部修改拒绝覆盖；撤过的再撤一次是幂等成功', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call } = await createProjectHarness(root)
    const edited = await call('project', 'edit', {
      steps: [{ action: 'replace', path: 'a.txt', oldText: 'one', newText: 'two' }],
    })
    expect(edited.changeRef).toStartWith('change:')
    await writeFile(join(root, 'a.txt'), 'three\n')
    expect((await failureOf(call('project', 'undo', { changeRef: edited.changeRef }))).code).toBe(
      'CONFLICT_WITH_EXTERNAL_EDIT'
    )
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three\n')

    await writeFile(join(root, 'b.txt'), 'b1\n')
    const second = await call('project', 'edit', {
      steps: [{ action: 'replace', path: 'b.txt', oldText: 'b1', newText: 'b2' }],
    })
    await call('project', 'undo', { changeRef: second.changeRef })
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b1\n')
    expect(await call('project', 'undo', { changeRef: second.changeRef })).toMatchObject({
      alreadyUndone: true,
    })
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b1\n')
  })

  test('INV-6 越出项目的路径一律拒绝，包括经符号链接指到项目外', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'project-acceptance-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside\n')
      await symlink(outside, join(root, 'link'))
      const { call } = await createProjectHarness(root)
      expect(
        (await failureOf(call('project', 'read', { files: [{ path: '../secret.txt' }] }))).code
      ).toBe('PERMISSION_DENIED')
      expect(
        (await failureOf(call('project', 'read', { files: [{ path: 'link/secret.txt' }] }))).code
      ).toBe('PERMISSION_DENIED')
      expect(
        (
          await failureOf(
            call('project', 'edit', {
              steps: [{ action: 'write', path: 'link/new.txt', text: 'x\n' }],
            })
          )
        ).code
      ).toBe('PERMISSION_DENIED')
      await expect(readFile(join(outside, 'new.txt'))).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-9 文本改动保留原来的 BOM 与换行，没改到的字节不动；新建文件是无 BOM 的 UTF-8、LF', async () => {
    await writeFile(join(root, 'crlf.txt'), Buffer.from(`${Bom}one\r\ntwo\r\nthree\r\n`, 'utf8'))
    const { call } = await createProjectHarness(root)
    await call('project', 'edit', {
      steps: [{ action: 'replace', path: 'crlf.txt', oldText: 'two', newText: 'TWO' }],
    })
    expect([...(await readFile(join(root, 'crlf.txt')))]).toEqual([
      ...Buffer.from(`${Bom}one\r\nTWO\r\nthree\r\n`, 'utf8'),
    ])
    await call('project', 'edit', {
      steps: [{ action: 'write', path: 'fresh.txt', text: 'a\nb\n' }],
    })
    expect([...(await readFile(join(root, 'fresh.txt')))]).toEqual([
      ...Buffer.from('a\nb\n', 'utf8'),
    ])
  })

  test('INV-13 同一个物理文件的项目内别名算同一个文件：一次编辑里出现两次整批拒绝；宿主的列举过滤器按真实路径判、只管列举', async () => {
    await writeFile(join(root, 'real.txt'), 'L1\nL2\n')
    await symlink('real.txt', join(root, 'link.txt'))
    const { call } = await createProjectHarness(root)
    const failure = await failureOf(
      call('project', 'edit', {
        steps: [
          { action: 'replace', path: 'link.txt', oldText: 'L1', newText: 'A' },
          { action: 'replace', path: 'real.txt', oldText: 'L2', newText: 'B' },
        ],
      })
    )
    expect(failure.code).toBe('INVALID_INPUT')
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('L1\nL2\n')

    await writeFile(join(root, '.env'), 'API_KEY=local\n')
    await symlink('.env', join(root, 'env.sample'))
    const filtered = await createProjectHarness(root, {
      providers: { fileFilter: { shouldInclude: ({ path }) => path !== '.env' } },
    })
    const listed = (await filtered.call('project', 'list', {})).entries.map(
      (entry: { path: string }) => entry.path
    )
    expect(listed).toContain('real.txt')
    expect(listed).not.toContain('.env')
    expect(listed).not.toContain('env.sample')
    expect((await filtered.read('.env')).text).toBe('API_KEY=local\n')
  })

  test('INV-14 没有读写名单：.git 里的、.env 这类照常能读能写，只受根内约束', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true })
    await writeFile(join(root, '.git', 'info', 'exclude'), '# local\n')
    const { call, read } = await createProjectHarness(root)
    expect((await read('.git/info/exclude')).text).toBe('# local\n')
    await call('project', 'edit', {
      steps: [
        {
          action: 'replace',
          path: '.git/info/exclude',
          oldText: '# local',
          newText: '# local\nscratch/',
        },
      ],
    })
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '# local\nscratch/\n'
    )
  })

  test('INV-10 没有生成文件名单：生成出来的文件也改得动', async () => {
    const { call } = await createProjectHarness(root)
    await call('project', 'edit', {
      steps: [{ action: 'write', path: 'src/api.generated.ts', text: 'export {}\n' }],
    })
    expect(await readFile(join(root, 'src/api.generated.ts'), 'utf8')).toBe('export {}\n')
  })

  test('INV-19 读出来的就是原文：像密钥的片段不遮，照常能改', async () => {
    // 假密钥拼出来写：源码里写成整串，公开前的扫描会把它当成真的 API key。
    const fakeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
    await writeFile(join(root, 'config.ts'), `export const key = "${fakeKey}"\n`)
    const { call, read } = await createProjectHarness(root)
    const view = await read('config.ts')
    expect(view.text).toBe(`export const key = "${fakeKey}"\n`)
    await call('project', 'edit', {
      steps: [
        {
          action: 'replace',
          path: 'config.ts',
          oldText: `"${fakeKey}"`,
          newText: 'process.env.KEY',
        },
      ],
    })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(
      'export const key = process.env.KEY\n'
    )
  })

  test('INV-20 程序看得到的只有 code 与 message：定位不唯一时 message 里有位置、候选与下一步', async () => {
    await writeFile(join(root, 'dup.txt'), 'same\nother\nsame\n')
    const { call } = await createProjectHarness(root)
    const failure = await failureOf(
      call('project', 'edit', {
        steps: [{ action: 'replace', path: 'dup.txt', oldText: 'same', newText: 'x' }],
      })
    )
    expect(failure.code).toBe('AMBIGUOUS_TARGET')
    expect(failure.message).toContain('steps[0]')
    expect(failure.message).not.toContain('edits[')
    expect(failure.message).toContain('候选')
    expect(failure.message).toContain('下一步')
  })

  test('INV-23 行号照 wc -l 数：读到文件末尾时正文结尾的换行照原样在，整份读回来原样写回不多一行也不少一行', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n\n')
    const { call, read } = await createProjectHarness(root)
    const whole = await read('a.txt')
    expect(whole).toMatchObject({ startLine: 1, text: 'one\ntwo\n\n', totalLines: 3 })
    // 范围停在一个空行上，那一行照样交出来；它是最后一行，结尾的换行跟着在。
    const ranged = await read('a.txt', [2, 3])
    expect(ranged).toMatchObject({ startLine: 2, text: 'two\n\n' })
    const partial = await read('a.txt', [1, 2])
    expect(partial).toMatchObject({ startLine: 1, text: 'one\ntwo' })
    await call('project', 'edit', {
      steps: [{ action: 'write', path: 'a.txt', text: `${whole.text}four\n` }],
    })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n\nfour\n')
    // 空文件是 0 行；越出行数的起始行在说明里报出文件实际有几行。
    await writeFile(join(root, 'empty.txt'), '')
    expect(await read('empty.txt')).toMatchObject({ text: '', totalLines: 0 })
    expect((await read('a.txt', 9)).note).toContain('文件共 4 行')
  })
})

describe('不折叠', () => {
  test('INV-24 read、list、search、edit、inspect 交回全部，看多少由程序定；只有守内存的上限，超了明说', async () => {
    const long = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`)
    await writeFile(join(root, 'long.txt'), `${long.join('\n')}\n`)
    await mkdir(join(root, 'a/b/c/d/e'), { recursive: true })
    await writeFile(join(root, 'a/b/c/d/e/leaf.txt'), 'leaf\n')
    for (let index = 0; index < 150; index++)
      await writeFile(join(root, `a/hit-${index}.txt`), `before\nneedle ${index}\nafter\n`)
    const { call, read, kernel } = await createProjectHarness(root)

    // 不给 range 就是整个文件：三千行都在，没有续读。
    const whole = await read('long.txt')
    expect(whole.text.split('\n')).toHaveLength(3001)
    expect(whole).not.toHaveProperty('continuation')
    // 不给 depth 就是整棵树：第五层的文件也在，没有分页。
    const listed = await call('project', 'list', { path: 'a' })
    expect(listed.entries.map((entry: { path: string }) => entry.path)).toContain(
      'a/b/c/d/e/leaf.txt'
    )
    expect(Object.keys(listed)).toEqual(['entries'])
    // 全部命中，每个命中的文件一段命中处的正文。
    const searched = await call('project', 'search', { query: 'needle' })
    expect(searched.hits).toHaveLength(150)
    expect(searched.files).toHaveLength(150)
    expect(searched.files.every((window: { text: string }) => window.text.includes('needle'))).toBe(
      true
    )
    // 差量是完整的：整份换掉三千行，每一行都在 diff 里，inspect 给的是同一份。
    const edited = await call('project', 'edit', {
      steps: [
        {
          action: 'write',
          path: 'long.txt',
          text: `${long.map((line) => `${line}!`).join('\n')}\n`,
        },
      ],
    })
    expect(edited.diff).toContain('+line 3000!')
    expect(edited).not.toHaveProperty('diffTruncated')
    expect((await call('project', 'inspect', { changeRef: edited.changeRef })).diff).toBe(
      edited.diff
    )

    // 守内存的上限：超了整个失败并说清怎么收窄，不交回一部分。
    kernel.search = async (input) => ({
      query: input.query,
      hits: [],
      truncated: true,
      diagnostics: ['ripgrep 搜索超过 120000 毫秒超时'],
    })
    const search = await failureOf(call('project', 'search', { query: 'needle' }))
    expect(search.code).toBe('SCOPE_VIOLATION')
    expect(search.message).toContain('收窄')
    kernel.listFiles = async (input) =>
      Array.from({ length: input?.maxFiles ?? 0 }, (_, index) => ({
        path: `f${index}`,
        type: 'file' as const,
      }))
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
    ])
      expect(project, phrase).toContain(phrase)
    const code = VelarCodeModule.declarations
    for (const phrase of [
      `最多 ${ProjectCodeLimits.extensions} 个`,
      `0–${ProjectCodeLimits.scanDepth}`,
      `超过 ${ProjectCodeLimits.results} 条`,
    ])
      expect(code, phrase).toContain(phrase)
  })
})

describe('不问人，只排队', () => {
  test('INV-17 改动与撤销不问人：上下文里没有审批端口、空间端口里没有授权口子，编辑、撤销照样做完', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const harness = await createProjectHarness(root)
    expect(Object.keys(harness.context).sort()).toEqual(['abortSignal', 'project', 'sessionId'])
    const edited = await harness.call('project', 'edit', {
      steps: [
        { action: 'write', path: 'created.txt', text: 'new\n' },
        { action: 'replace', path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' },
      ],
    })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    await harness.call('project', 'undo', { changeRef: edited.changeRef })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    await expect(readFile(join(root, 'created.txt'))).rejects.toThrow()
  })

  test('INV-8 同一项目根上写串行、读并发；排队的写者不被后来的读者饿死；取消了的等待者不运行', async () => {
    const gate = new ProjectExecutionGate()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstRead = gate.run(
      '/repo',
      false,
      new AbortController().signal,
      () =>
        new Promise<void>((done) => {
          order.push('read-1 start')
          releaseFirst = done
        })
    )
    const secondRead = gate.run('/repo', false, new AbortController().signal, async () => {
      order.push('read-2')
    })
    await secondRead
    const writer = gate.run('/repo', true, new AbortController().signal, async () => {
      order.push('write')
    })
    const lateRead = gate.run('/repo', false, new AbortController().signal, async () => {
      order.push('read-3')
    })
    const abort = new AbortController()
    const cancelled = gate.run('/repo', true, abort.signal, async () => {
      order.push('cancelled')
    })
    abort.abort()
    releaseFirst()
    await Promise.all([firstRead, writer, lateRead, cancelled.catch(() => undefined)])
    expect(order).toEqual(['read-1 start', 'read-2', 'write', 'read-3'])
  })
})

describe('共用能力的项目端口', () => {
  test('INV-26 项目里的危险命令每次都由用户亲自确认；被拒一个进程都不起；别的命令（会改项目的、长驻的也一样）不问，直接跑，输出原样交回', async () => {
    const denied = await createProjectPortsHarness(root, { approve: false })
    expect((await failureOf(denied.call('shell', 'run', { command: 'rm -rf ./dist' }))).code).toBe(
      'PERMISSION'
    )
    expect(denied.runs).toEqual([])
    expect(denied.confirmations).toHaveLength(1)
    expect(denied.confirmations[0]?.options).toMatchObject({
      approvalRisk: 'high',
      requireManualApproval: true,
      rememberRiskScope: false,
      riskScope: 'project-command:dangerous',
    })
    expect(denied.confirmations[0]?.message).toContain('当前项目')

    // 用户点了头：宿主收到的是「已确认的危险命令」。
    const approved = await createProjectPortsHarness(root)
    await approved.call('shell', 'run', { command: 'rm -rf ./dist' })
    expect(
      approved.runs.map(({ command, allowDangerous }) => ({ command, allowDangerous }))
    ).toEqual([{ command: 'rm -rf ./dist', allowDangerous: true }])

    // 会改项目的、长驻的都不问（审批端口会拒，也一次都没被叫到）；输出原样交回，像密钥的片段也不遮。
    const secret = ['sk', 'live', '0123456789abcdefghijklmnopqrstuvwxyz'].join('-')
    const quiet = await createProjectPortsHarness(root, {
      approve: false,
      runCommand: async (command, options) =>
        commandResult(command, options?.cwd ?? root, { stdout: `key=${secret}` }),
    })
    for (const command of ['touch created.txt', 'npm run dev', 'ls'])
      expect((await quiet.call('shell', 'run', { command })).stdout).toBe(`key=${secret}`)
    expect(quiet.confirmations).toEqual([])
    expect(quiet.runs.map(({ command, options }) => [command, options?.background])).toEqual([
      ['touch created.txt', false],
      ['npm run dev', true],
      ['ls', false],
    ])
  })

  test('INV-27 命令的工作目录与沙箱的源目录按真实路径钳在项目之内：出了项目（含经符号链接指到外面）在问用户之前就拒绝，一个进程都不起、什么都不镜像', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'project-acceptance-outside-'))
    await mkdir(join(root, 'src'))
    await symlink(outside, join(root, 'escape'))
    const sandbox = fakeSandboxHost(root)
    try {
      const harness = await createProjectPortsHarness(root, { sandbox: sandbox.host })
      for (const where of ['..', outside, 'escape', 'escape/deeper']) {
        const refused = await failureOf(
          harness.call('shell', 'run', { command: 'rm -rf build', cwd: where })
        )
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
      expect(await harness.call('sandbox', 'create', { source: 'src' })).toMatchObject({
        source: join(root, 'src'),
      })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-28 演练沙箱落回不问人、不按名单拦：点名的路径核过就把同一份差量的指纹交给宿主落回，点名了没变化的就拒绝；镜像里命令的输出原样交回', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    const sandbox = fakeSandboxHost(root, {
      stdout: `${secret}\n`,
      diff: {
        created: ['src/api.generated.ts'],
        modified: ['notes.txt', '.env'],
        deleted: ['deploy.key'],
        fingerprint: 'fp',
      },
    })
    const { call, confirmations } = await createProjectPortsHarness(root, {
      sandbox: sandbox.host,
      approve: false,
    })
    const applied = await call('sandbox', 'apply', { id: 'sb' })
    expect(applied).toMatchObject({
      created: ['src/api.generated.ts'],
      modified: ['notes.txt', '.env'],
      deleted: ['deploy.key'],
    })
    expect(sandbox.calls.at(-1)).toEqual({ apply: { sandboxId: 'sb', fingerprint: 'fp' } })
    const unknown = await failureOf(
      call('sandbox', 'apply', { id: 'sb', paths: ['never-changed.txt'] })
    )
    expect(unknown.code).toBe('VALIDATION')
    expect(unknown.message).toContain('never-changed.txt')
    expect(sandbox.calls.filter((entry) => 'apply' in entry)).toHaveLength(1)
    expect((await call('sandbox', 'run', { id: 'sb', command: 'cat .env' })).stdout).toBe(
      `${secret}\n`
    )
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
      const seen = await call('images', 'view', {
        files: [{ path: 'shot.png' }, { path: '.env.png' }, { path: 'link.png' }],
      })
      expect(seen.files).toMatchObject([
        { path: 'shot.png', width: 40, height: 30 },
        { path: '.env.png', width: 10 },
        { path: 'link.png', error: { code: 'PERMISSION' } },
      ])
      expect(attachments).toHaveLength(2)
      expect(
        (await failureOf(call('images', 'view', { files: [{ path: join(outside, 'far.png') }] })))
          .code
      ).toBe('PERMISSION')
      expect(attachments).toHaveLength(2)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
