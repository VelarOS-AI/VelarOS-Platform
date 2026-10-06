/**
 * 演练沙箱的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 公共规则与 `velaros:sandbox` 的操作用假宿主测；本机演练沙箱（`./local` 入口）的承诺用真宿主、真约束后端测（INV-9～INV-14），
 * 沙箱都建在各用例自己的临时基目录下，不碰共用的那一个。
 */

import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import type { ApprovalPort } from '@velaros-ai/kernel'
import type { CodeCapabilityPort } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'
import { ShellErrorCodes, ShellLimits } from '@velaros-ai/velaros/execution/contracts'

import { VelarSandboxModule } from '../contract/surface'
import type {
  SandboxApplyInput,
  SandboxCreateInput,
  SandboxDiffInput,
  SandboxDiscardInput,
  SandboxOperationContext,
  SandboxRunInput,
  SandboxRunOptions,
  SandboxSurfacePort,
} from '../index'
import {
  rehearsalSandboxRules,
  type SandboxDiff,
  SandboxErrorCodes,
  sandboxOperations,
} from '../index'
import { createLocalSandboxHost } from '../local'
import { assertInsideSandboxBase } from '../utils/mirror'

import {
  canConfine,
  discardAll,
  failureOf,
  makeScratch,
  makeSource,
  removeScratch,
  systemSandboxSpace,
} from './support'

function diffOf(overrides: Partial<SandboxDiff> = {}): SandboxDiff {
  return {
    sandboxId: 's1',
    source: '/repo',
    created: [],
    modified: [],
    deleted: [],
    gitChanged: false,
    textDiffs: [],
    omittedDiffs: 0,
    fingerprint: 'fp1',
    ...overrides,
  }
}

/** 模型这一轮读到的能力声明：就是提交进仓的那份生成物：程序照它核对 import，代码模版照它过类型检查。 */
const ModelFacingDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/sandbox.d.ts', import.meta.url)),
  'utf8'
)

/** 一个空间的假宿主：作用域怎么钳由 clamp 决定（真 = project 那样钳在根内，假 = system 那样收任意绝对路径），端口收到的每一次调用都记下来。 */
function fakeSpace(options: { root: string; clamp: boolean; approved?: boolean }) {
  const calls: Array<Record<string, unknown>> = []
  const runs: SandboxRunOptions[] = []
  const confirmations: string[] = []
  const confirmationOptions: unknown[] = []
  const changes = diffOf({
    sandboxId: 'sb-1',
    source: `${options.root}/src`,
    created: ['note.txt'],
    modified: ['main.ts'],
  })
  const port: SandboxSurfacePort = {
    resolveSource: async (source) => {
      calls.push({ resolveSource: source ?? null })
      if (source === undefined) return options.root
      if (!options.clamp) return source
      const resolved = resolve(options.root, source)
      if (resolved !== options.root && !resolved.startsWith(`${options.root}/`)) {
        throw new AppError('PERMISSION', `${source} 在项目之外，沙箱只镜像项目内的目录。`)
      }
      return resolved
    },
    createSandbox: async (createOptions) => {
      calls.push({ createSandbox: createOptions?.source ?? null })
      return {
        id: changes.sandboxId,
        root: `/tmp/sandboxes/${changes.sandboxId}`,
        source: createOptions?.source ?? options.root,
        createdAt: 0,
        network: createOptions?.network ?? false,
        ignored: createOptions?.ignored ?? 'link',
        fileCount: 3,
        bytes: 300,
        linkedDirectories: [],
        git: false,
      }
    },
    runInSandbox: async (runOptions) => {
      calls.push({ runInSandbox: runOptions.command, inSandbox: runOptions.sandboxId })
      runs.push(runOptions)
      return {
        exitCode: 0,
        stdout: '3 pass 0 fail',
        stderr: '',
        durationMs: 12,
        timedOut: false,
        truncated: false,
        success: true,
      }
    },
    diffSandbox: async (diffOptions) => {
      calls.push({
        diffSandbox: diffOptions.sandboxId,
        paths: diffOptions.paths ?? null,
        textDiffs: diffOptions.textDiffs ?? null,
      })
      return changes
    },
    applySandbox: async (applyOptions) => {
      calls.push({
        applySandbox: applyOptions.sandboxId,
        fingerprint: applyOptions.fingerprint ?? null,
      })
      return {
        sandboxId: applyOptions.sandboxId,
        created: changes.created,
        modified: changes.modified,
        deleted: changes.deleted,
        skippedGit: false,
      }
    },
    discardSandbox: async (sandboxId) => {
      calls.push({ discardSandbox: sandboxId })
      return { sandboxId, removed: true }
    },
  }
  const approval: ApprovalPort = {
    awaitConfirmation: async (message, _signal, confirmation) => {
      confirmations.push(message)
      confirmationOptions.push(confirmation)
      if (options.approved === false) throw new AppError('PERMISSION', '用户没有同意。')
    },
    awaitConfirmationDecision: async (message) => {
      confirmations.push(message)
      return { approved: options.approved !== false, message: null, autoApproved: false }
    },
  }
  return {
    calls,
    runs,
    confirmations,
    confirmationOptions,
    context: {
      abortSignal: new AbortController().signal,
      sandbox: port,
      approval,
    } satisfies SandboxOperationContext,
  }
}

/** 把一次能力调用转给命名空间的五个操作；抛出来的错由代码面变成模型程序里能 try/catch 的异常。 */
async function invokeOperation(
  operation: string,
  input: unknown,
  context: SandboxOperationContext
): Promise<unknown> {
  if (operation === 'create') return sandboxOperations.create(input as SandboxCreateInput, context)
  if (operation === 'run') return sandboxOperations.run(input as SandboxRunInput, context)
  if (operation === 'diff') return sandboxOperations.diff(input as SandboxDiffInput, context)
  if (operation === 'apply') return sandboxOperations.apply(input as SandboxApplyInput, context)
  if (operation === 'discard')
    return sandboxOperations.discard(input as SandboxDiscardInput, context)
  throw new AppError('VALIDATION', `没有 sandbox.${operation} 这个操作。`)
}

/** 让一段真程序过语法检查，再在隔离里跑完，交出它 return 的东西。 */
async function runModelProgram(
  space: ReturnType<typeof fakeSpace>,
  source: string
): Promise<unknown> {
  const capabilities: CodeCapabilityPort = {
    listOperations: () => ({ sandbox: ['create', 'run', 'diff', 'apply', 'discard'] }),
    invoke: async ({ operation, input }) => {
      try {
        return { value: await invokeOperation(operation, input, space.context) }
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return {
          error: { code: failure.code ?? 'UNKNOWN', message: failure.message ?? String(error) },
        }
      }
    },
  }
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities,
  })
  const granted = [{ namespace: 'sandbox', declarations: ModelFacingDeclarations }]
  const outcome = await session.submit({ program: { source }, granted, timeoutMs: 20_000 })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过检查：${why}`)
  }
  if (outcome.result.failed) throw new Error(`程序没跑完：${outcome.result.failed.message}`)
  return outcome.result.value
}

/** 端到端那条程序：建镜像、在里面跑测试、看变化，自己算一下再决定落回还是丢弃。中间结果一个都不进上下文。 */
const EndToEndProgram = `import { create, run, diff, apply, discard } from 'velaros:sandbox'

const box = await create({ source: 'src' })
const ran = await run({ id: box.id, command: 'bun test' })
const changes = ran.success ? await diff({ id: box.id }) : null
const touched = changes ? [...changes.created, ...changes.modified, ...changes.deleted] : []
export default !changes
  ? { 没跑过: ran.stderr }
  : touched.length > 20 ? await discard({ id: box.id }) : await apply({ id: box.id })`

describe('落回前的核对', () => {
  test('INV-1 核对过的就是要落的：三列永远完整（不按条数截），交回的就是完整的三列', () => {
    const created = Array.from({ length: 2120 }, (_, index) => `new/${index}.txt`)
    const selection = rehearsalSandboxRules.prepareApply({
      diff: diffOf({ created, modified: ['.ssh/config'] }),
    })
    expect(selection).toEqual({ created, modified: ['.ssh/config'], deleted: [], unknown: [] })
  })

  test('INV-2 点名了没有变化的路径就拒绝，什么都没写；什么都没变返回 null', () => {
    expect(() =>
      rehearsalSandboxRules.prepareApply({
        diff: diffOf({ modified: ['a.ts'] }),
        paths: ['a.ts', 'ghost.ts'],
      })
    ).toThrow('ghost.ts')
    expect(rehearsalSandboxRules.prepareApply({ diff: diffOf() })).toBeNull()
    expect(
      rehearsalSandboxRules.prepareApply({
        diff: diffOf({ modified: ['a.ts'], deleted: ['b.ts'] }),
        paths: ['./a.ts'],
      })
    ).toEqual({ created: [], modified: ['a.ts'], deleted: [], unknown: [] })
  })

  test('INV-3 落回不问用户：审批端口一次都没被叫到，删除与覆盖照样落', async () => {
    const space = fakeSpace({ root: '/repo', clamp: false, approved: false })
    const applied = await sandboxOperations.apply({ id: 'sb-1' }, space.context)
    expect(applied).toEqual({
      sandboxId: 'sb-1',
      created: ['note.txt'],
      modified: ['main.ts'],
      deleted: [],
      skippedGit: false,
    })
    expect(space.confirmations).toEqual([])
    expect(space.calls.at(-1)).toEqual({ applySandbox: 'sb-1', fingerprint: 'fp1' })
  })
})

describe('代码面 sandbox 命名空间', () => {
  test('INV-5 一段真程序照生成的声明过检查，在隔离里跑完 create → run → diff → apply', async () => {
    const space = fakeSpace({ root: '/repo', clamp: true })
    const value = await runModelProgram(space, EndToEndProgram)

    // 回执就是落回的结果本身，中间那三次调用一个字都没进上下文。
    expect(value).toEqual({
      sandboxId: 'sb-1',
      created: ['note.txt'],
      modified: ['main.ts'],
      deleted: [],
      skippedGit: false,
    })
    // 作用域：模型写的是 src，落到宿主端口上的是钳过的绝对路径。
    expect(space.calls[0]).toEqual({ resolveSource: 'src' })
    expect(space.calls[1]).toEqual({ createSandbox: '/repo/src' })
    expect(space.calls[2]).toEqual({ runInSandbox: 'bun test', inSandbox: 'sb-1' })
    // 落回前那次差量必须是不截断的完整差量，核对之后把同一个指纹交回宿主；整条链没问过用户。
    expect(space.calls.at(-2)).toEqual({ diffSandbox: 'sb-1', paths: null, textDiffs: false })
    expect(space.calls.at(-1)).toEqual({ applySandbox: 'sb-1', fingerprint: 'fp1' })
    expect(space.confirmations).toEqual([])
  }, 30_000)

  test('INV-5 作用域由宿主注入，不由模型挑：project 那样的端口把越界的 source 拒掉，system 那样的收任意绝对路径', async () => {
    const clamped = fakeSpace({ root: '/repo', clamp: true })
    const refused = await runModelProgram(
      clamped,
      `import { create } from 'velaros:sandbox'

let outcome
try {
  await create({ source: '../outside' })
  outcome = '没拦住'
} catch (error) {
  outcome = { 拒绝: error.message }
}
export default outcome`
    )
    expect(refused).toEqual({ 拒绝: '../outside 在项目之外，沙箱只镜像项目内的目录。' })
    expect(clamped.calls.some((call) => 'createSandbox' in call)).toBe(false)

    const anywhere = fakeSpace({ root: '/home/me', clamp: false })
    const mirrored = await runModelProgram(
      anywhere,
      `import { create } from 'velaros:sandbox'
const box = await create({ source: '/etc/app' })
export default box.source`
    )
    expect(mirrored).toBe('/etc/app')
  }, 30_000)
})

describe('镜像里的危险命令', () => {
  test('INV-7 镜像里的危险命令照常先问用户：高风险、手动、不可记忆；被拒就抛错，宿主一个进程都不起；不危险的不打扰', async () => {
    const declined = fakeSpace({ root: '/repo', clamp: true, approved: false })
    const refused = await runModelProgram(
      declined,
      `import { create, run } from 'velaros:sandbox'

const box = await create({})
let outcome
try {
  await run({ id: box.id, command: 'rm -rf build' })
  outcome = '没拦住'
} catch (error) {
  outcome = { 拒绝: error.message }
}
export default outcome`
    )
    expect(refused).toEqual({ 拒绝: '用户没有同意。' })
    expect(declined.confirmations).toHaveLength(1)
    expect(declined.confirmations[0]).toContain('演练沙箱 sb-1 的镜像里')
    expect(declined.confirmationOptions[0]).toMatchObject({
      approvalRisk: 'high',
      requireManualApproval: true,
      rememberRiskScope: false,
      operation: { target: '演练沙箱 sb-1' },
    })
    expect(declined.calls.some((call) => 'runInSandbox' in call)).toBe(false)

    const approved = fakeSpace({ root: '/repo', clamp: true })
    await sandboxOperations.run(
      { id: 'sb-1', command: 'rm -rf build && bun run build' },
      approved.context
    )
    expect(approved.confirmations).toHaveLength(1)
    expect(approved.calls).toContainEqual({
      runInSandbox: 'rm -rf build && bun run build',
      inSandbox: 'sb-1',
    })

    const quiet = fakeSpace({ root: '/repo', clamp: true })
    await sandboxOperations.run({ id: 'sb-1', command: 'bun test' }, quiet.context)
    expect(quiet.confirmations).toEqual([])
  }, 30_000)
})

describe('不折叠', () => {
  test('INV-8 diff 的三列永远完整、paths 只要其中几个的文本差量原样交给宿主；镜像里命令的输出只守内存的上限', async () => {
    const space = fakeSpace({ root: '/repo', clamp: false })
    await sandboxOperations.diff({ id: 'sb-1', paths: ['src/a.ts'] }, space.context)
    expect(space.calls.at(-1)).toEqual({
      diffSandbox: 'sb-1',
      paths: ['src/a.ts'],
      textDiffs: null,
    })
    await sandboxOperations.run({ id: 'sb-1', command: 'bun test' }, space.context)
    expect(space.runs.at(-1)).toMatchObject({
      command: 'bun test',
      maxOutputChars: ShellLimits.outputChars,
    })
    for (const hidden of ['maxFiles', 'maxOutputChars'])
      expect(VelarSandboxModule.declarations).not.toContain(hidden)
  })
})

describe('代码模版', () => {
  test('INV-6 代码模版整份照真实声明过类型检查；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
    const declarations = readFileSync(
      resolve(root, '../../../baselines/script/sandbox.d.ts'),
      'utf8'
    )
    const template = readFileSync(resolve(root, 'template.js'), 'utf8')
    const checked = codeProgramChecker.typecheck({
      source: template,
      granted: [{ namespace: 'sandbox', declarations }],
    })
    expect(checked.ok ? [] : checked.diagnostics).toEqual([])
    expect(VelarSandboxModule.template).toBe(template.trim())
    expect(declarations).not.toContain('的代码模版')
  })
})

describe('本机演练沙箱：镜像里的命令一律受约束', () => {
  test.skipIf(!canConfine)(
    'INV-9 run 的命令钉在镜像根：写到镜像外失败、源目录一个字节不变，写镜像里照常',
    async () => {
      const source = await makeSource()
      const base = await makeScratch('base')
      const host = createLocalSandboxHost({ baseDir: base })
      const space = systemSandboxSpace(host, { cwd: source })
      try {
        const box = await space.call<{ id: string; root: string }>('create')
        const outside = await space.call<{ success: boolean }>('run', {
          id: box.id,
          command: `printf clobbered > "${join(source, 'a.txt')}"`,
        })
        expect(outside.success).toBe(false)
        expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('alpha\n')
        const inside = await space.call<{ success: boolean }>('run', {
          id: box.id,
          command: 'printf ok > b.txt',
        })
        expect(inside.success).toBe(true)
        expect(await readFile(join(box.root, 'b.txt'), 'utf8')).toBe('ok')
        expect(existsSync(join(source, 'b.txt'))).toBe(false)
      } finally {
        await discardAll(host)
        await removeScratch(base)
        await removeScratch(source)
      }
    }
  )

  test('INV-9 没有约束后端的宿主建不出沙箱：报 SHELL_CONFINEMENT_UNAVAILABLE，基目录下不留没有约束的副本', async () => {
    const source = await makeSource()
    const base = await makeScratch('base')
    // 按一个没有内置约束后端的平台跑。
    const host = createLocalSandboxHost({ platform: 'freebsd', baseDir: base })
    try {
      await expect(host.createSandbox({ source })).rejects.toMatchObject({
        code: ShellErrorCodes.processConfinementUnavailable,
      })
      expect(await readdir(base)).toEqual([])
      expect(host.listSandboxes()).toEqual([])
    } finally {
      await host.dispose()
      await removeScratch(base)
      await removeScratch(source)
    }
  })

  test.skipIf(!canConfine)(
    'INV-9 清单读不出来时镜像里的命令拒绝执行（NOT_FOUND），不退回裸进程；看差量同样拒绝',
    async () => {
      const source = await makeSource()
      const base = await makeScratch('base')
      const first = createLocalSandboxHost({ baseDir: base })
      const record = await first.createSandbox({ source })
      await first.dispose()
      // 清单写坏了（写到一半崩溃、临时区清理只删了它）：重启后的宿主认不出这是沙箱。
      await writeFile(join(base, record.id, 'manifest.json'), '{"version":1,')
      const second = createLocalSandboxHost({ baseDir: base })
      try {
        await expect(
          second.runInSandbox({
            sandboxId: record.id,
            command: `printf clobbered > "${join(source, 'a.txt')}"`,
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('alpha\n')
        await expect(second.diffSandbox({ sandboxId: record.id })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
        // 从来没建过的沙箱也一样：没有清单就不跑。
        await expect(
          second.runInSandbox({ sandboxId: '20260101-000000-abcdef', command: 'true' })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(second.listSandboxes()).toEqual([])
      } finally {
        await second.discardSandbox(record.id)
        await second.dispose()
        await removeScratch(base)
        await removeScratch(source)
      }
    }
  )
})

describe('本机演练沙箱：落回', () => {
  test.skipIf(!canConfine)(
    'INV-10 落回只写清单记过的文件：源目录自建沙箱以来变过就整批不落（SANDBOX_CONFLICT，not-applied），冲突列在 message 与 context 里',
    async () => {
      const source = await makeSource()
      const base = await makeScratch('base')
      const host = createLocalSandboxHost({ baseDir: base })
      try {
        const record = await host.createSandbox({ source })
        await writeFile(join(record.root, 'a.txt'), 'ALPHA\n')
        await writeFile(join(record.root, 'b.txt'), 'beta\n')
        await writeFile(join(source, 'a.txt'), 'changed outside\n')
        const failure = await failureOf(host.applySandbox({ sandboxId: record.id }))
        expect(failure).toMatchObject({
          code: SandboxErrorCodes.conflict,
          context: { executionOutcome: 'not-applied' },
        })
        expect(failure.message).toContain('a.txt')
        expect(failure.context.conflicts).toEqual([
          expect.objectContaining({ path: 'a.txt', reason: 'changed' }),
        ])
        expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('changed outside\n')
        expect(existsSync(join(source, 'b.txt'))).toBe(false)
        // 没冲突的那一个单独落照常。
        const applied = await host.applySandbox({ sandboxId: record.id, paths: ['b.txt'] })
        expect(applied.created).toEqual(['b.txt'])
        expect(await readFile(join(source, 'b.txt'), 'utf8')).toBe('beta\n')
      } finally {
        await discardAll(host)
        await removeScratch(base)
        await removeScratch(source)
      }
    }
  )

  test.skipIf(!canConfine)('INV-10 任何一层的 .git（含嵌套仓库）永远不落', async () => {
    const source = await makeSource()
    await mkdir(join(source, 'vendor-repo', '.git'), { recursive: true })
    await writeFile(join(source, 'vendor-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(source, 'vendor-repo', 'lib.txt'), 'lib\n')
    const base = await makeScratch('base')
    const host = createLocalSandboxHost({ baseDir: base })
    try {
      const record = await host.createSandbox({ source })
      await writeFile(
        join(record.root, 'vendor-repo', '.git', 'HEAD'),
        'ref: refs/heads/rehearsal\n'
      )
      await writeFile(join(record.root, 'vendor-repo', 'lib.txt'), 'LIB\n')
      const changes = await host.diffSandbox({ sandboxId: record.id })
      expect(changes).toMatchObject({ modified: ['vendor-repo/lib.txt'], gitChanged: true })
      const applied = await host.applySandbox({ sandboxId: record.id })
      expect(applied).toMatchObject({ modified: ['vendor-repo/lib.txt'], skippedGit: true })
      expect(await readFile(join(source, 'vendor-repo', '.git', 'HEAD'), 'utf8')).toBe(
        'ref: refs/heads/main\n'
      )
      expect(await readFile(join(source, 'vendor-repo', 'lib.txt'), 'utf8')).toBe('LIB\n')
    } finally {
      await discardAll(host)
      await removeScratch(base)
      await removeScratch(source)
    }
  })

  test.skipIf(!canConfine)(
    'INV-13 落回只落核对过的那份差量：核对之后镜像又变了就整批不落（SANDBOX_CHANGED，not-applied）',
    async () => {
      const source = await makeSource()
      const base = await makeScratch('base')
      const host = createLocalSandboxHost({ baseDir: base })
      try {
        const record = await host.createSandbox({ source })
        await writeFile(join(record.root, 'b.txt'), 'beta\n')
        // 核对完差量之后镜像里还有东西在写（这里直接写一个新文件）：核对的是一份，镜像里已经是另一份。
        const confirmed = await host.diffSandbox({ sandboxId: record.id, textDiffs: false })
        expect(confirmed.created).toEqual(['b.txt'])
        await writeFile(join(record.root, 'c.txt'), 'late\n')
        const failure = await failureOf(
          host.applySandbox({ sandboxId: record.id, fingerprint: confirmed.fingerprint })
        )
        expect(failure).toMatchObject({
          code: SandboxErrorCodes.changed,
          context: { executionOutcome: 'not-applied' },
        })
        expect(existsSync(join(source, 'b.txt'))).toBe(false)
        expect(existsSync(join(source, 'c.txt'))).toBe(false)
      } finally {
        await discardAll(host)
        await removeScratch(base)
        await removeScratch(source)
      }
    }
  )

  test.skipIf(!canConfine)(
    'INV-14 落回只写在源目录之内：上级路径是符号链接就按冲突整批不落，暂存拷不全什么都不落、不留暂存目录',
    async () => {
      const source = await makeSource()
      const outside = await makeScratch('outside')
      await symlink(outside, join(source, 'ext'))
      const base = await makeScratch('base')
      const host = createLocalSandboxHost({ baseDir: base })
      try {
        const record = await host.createSandbox({ source })
        // 镜像里把指向源目录外的链接换成真目录，只落里面的新文件：源目录里的链接还在，落回会穿过它写到外面。
        await rm(join(record.root, 'ext'))
        await mkdir(join(record.root, 'ext'))
        await writeFile(join(record.root, 'ext', 'evil.txt'), 'evil\n')
        const escaped = await failureOf(
          host.applySandbox({ sandboxId: record.id, paths: ['ext/evil.txt'] })
        )
        expect(escaped.code).toBe(SandboxErrorCodes.conflict)
        expect((escaped.context.conflicts as unknown[])[0]).toMatchObject({
          path: 'ext/evil.txt',
          reason: 'link',
        })
        expect(existsSync(join(outside, 'evil.txt'))).toBe(false)

        // 暂存拷不全（镜像里有个文件读不出来）：别的文件也一个都不落，源目录里不留暂存目录。
        await writeFile(join(record.root, 'a.txt'), 'ALPHA\n')
        await writeFile(join(record.root, 'b.txt'), 'beta\n')
        await chmod(join(record.root, 'a.txt'), 0o000)
        const staged = await failureOf(
          host.applySandbox({ sandboxId: record.id, paths: ['a.txt', 'b.txt'] })
        )
        await chmod(join(record.root, 'a.txt'), 0o644)
        expect(staged.context.executionOutcome).toBe('not-applied')
        expect(existsSync(join(source, 'b.txt'))).toBe(false)
        expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('alpha\n')
        expect(
          (await readdir(source)).filter((name) => name.startsWith('.velaros-sandbox-'))
        ).toEqual([])
      } finally {
        await discardAll(host)
        await removeScratch(base)
        await removeScratch(source)
        await removeScratch(outside)
      }
    }
  )
})

describe('本机演练沙箱：丢弃', () => {
  test('INV-11 丢弃只删沙箱基目录下面正好一层的沙箱目录：id 不合形状、这一项是符号链接、解开链接后不在基目录之下或就是基目录本身，一律拒绝', async () => {
    const base = await makeScratch('base')
    const victim = await makeScratch('victim')
    const host = createLocalSandboxHost({ baseDir: base })
    try {
      await expect(assertInsideSandboxBase('/etc', base)).rejects.toMatchObject({
        code: 'PERMISSION',
      })
      await expect(assertInsideSandboxBase(join(base, '..'), base)).rejects.toMatchObject({
        code: 'PERMISSION',
      })
      // 基目录本身不在「之下」：删它等于删掉所有沙箱。
      await expect(assertInsideSandboxBase(base, base)).rejects.toMatchObject({
        code: 'PERMISSION',
      })
      await expect(host.discardSandbox('../../etc')).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(host.discardSandbox('20260101-000000-zzzzzz/..')).rejects.toMatchObject({
        code: 'VALIDATION',
      })
      // 合形状的 id 却是符号链接（指向别处）：拒绝，链接指向的东西一个字节都不动。
      await writeFile(join(victim, 'keep.txt'), 'keep\n')
      await symlink(victim, join(base, '20260101-000000-abcdef'))
      await expect(host.discardSandbox('20260101-000000-abcdef')).rejects.toMatchObject({
        code: 'PERMISSION',
      })
      expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('keep\n')
      // 本来就不在的沙箱：removed 为 false，不算错。
      expect(await host.discardSandbox('20260101-000000-fedcba')).toEqual({
        sandboxId: '20260101-000000-fedcba',
        removed: false,
      })
    } finally {
      await rm(join(base, '20260101-000000-abcdef'), { force: true })
      await host.dispose()
      await removeScratch(base)
      await removeScratch(victim)
    }
  })
})

describe('本机演练沙箱：镜像仓库推不出去', () => {
  test.skipIf(!canConfine)(
    'INV-12 镜像仓库的每个远端推送地址都被改掉，源目录的配置不动',
    async () => {
      const source = await makeSource()
      const base = await makeScratch('base')
      const host = createLocalSandboxHost({ baseDir: base })
      try {
        const record = await host.createSandbox({ source })
        expect(record.git).toBe(true)
        expect(record.network).toBe(false)
        expect(await readFile(join(record.root, '.git', 'config'), 'utf8')).toContain(
          'pushurl = DISABLED-BY-VELAROS-SANDBOX'
        )
        expect(await readFile(join(source, '.git', 'config'), 'utf8')).not.toContain('pushurl')
      } finally {
        await discardAll(host)
        await removeScratch(base)
        await removeScratch(source)
      }
    }
  )

  test.skipIf(!canConfine)(
    'INV-12 嵌套仓库、子模块和各种节头写法的远端也推不出去，指向源目录外的 .git 链接不进镜像',
    async () => {
      const source = await makeSource()
      // 顶层配置：CRLF 换行、节名大写且节头后带空白、旧式 [remote.x] 写法，git 都照常认。
      await writeFile(
        join(source, '.git', 'config'),
        '[remote "origin"]\r\n\turl = git@github.com:example/demo.git\r\n[Remote "UP"] \n\turl = /tmp/up.git\n[remote.legacy]\n\turl = /tmp/legacy.git\n'
      )
      // 子模块：.git 是指向顶层 .git/modules/mod 的链接文件，那份配置也有远端。
      await mkdir(join(source, '.git', 'modules', 'mod'), { recursive: true })
      await writeFile(
        join(source, '.git', 'modules', 'mod', 'config'),
        '[remote "origin"]\n\turl = /tmp/mod.git\n'
      )
      await mkdir(join(source, 'mod'))
      await writeFile(join(source, 'mod', '.git'), 'gitdir: ../.git/modules/mod\n')
      // 嵌套的独立仓库。
      await mkdir(join(source, 'nested', '.git'), { recursive: true })
      await writeFile(
        join(source, 'nested', '.git', 'config'),
        '[remote "origin"]\n\turl = /tmp/nested.git\n'
      )
      // git worktree：.git 指向源目录外的真实仓库，放进镜像的话镜像里的 git 会直接读写它。
      const elsewhere = await makeScratch('worktree')
      await mkdir(join(source, 'wt'))
      await writeFile(join(source, 'wt', '.git'), `gitdir: ${elsewhere}\n`)
      const base = await makeScratch('base')
      const host = createLocalSandboxHost({ baseDir: base })
      try {
        const record = await host.createSandbox({ source })
        const disabled = (text: string, count: number) =>
          expect(text.split('pushurl = DISABLED-BY-VELAROS-SANDBOX').length - 1).toBe(count)
        disabled(await readFile(join(record.root, '.git', 'config'), 'utf8'), 3)
        expect(await readFile(join(record.root, '.git', 'config'), 'utf8')).toContain(
          '[remote "origin"]\r\n\tpushurl = DISABLED-BY-VELAROS-SANDBOX\r\n'
        )
        disabled(await readFile(join(record.root, '.git', 'modules', 'mod', 'config'), 'utf8'), 1)
        disabled(await readFile(join(record.root, 'nested', '.git', 'config'), 'utf8'), 1)
        expect(existsSync(join(record.root, 'mod', '.git'))).toBe(true)
        expect(existsSync(join(record.root, 'wt', '.git'))).toBe(false)
        expect(record.detachedGitLinks).toEqual(['wt/.git'])
        // 剪推送改的配置不算镜像里的变化：刚建好的沙箱差量是干净的。
        expect((await host.diffSandbox({ sandboxId: record.id })).gitChanged).toBe(false)
        // 本机有 git 就让 git 自己读一遍：三种写法的远端都认出了那条无效推送地址。
        if (Bun.which('git')) {
          for (const name of ['origin', 'UP', 'legacy']) {
            const read = Bun.spawnSync([
              'git',
              'config',
              '--file',
              join(record.root, '.git', 'config'),
              '--get-all',
              `remote.${name}.pushurl`,
            ])
            expect({ name, pushurl: read.stdout.toString().trim() }).toEqual({
              name,
              pushurl: 'DISABLED-BY-VELAROS-SANDBOX',
            })
          }
        }
      } finally {
        await discardAll(host)
        await removeScratch(base)
        await removeScratch(source)
        await removeScratch(elsewhere)
      }
    }
  )
})
