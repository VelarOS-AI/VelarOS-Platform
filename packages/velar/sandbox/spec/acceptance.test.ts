/**
 * 演练沙箱公共规则的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { CodeCapabilityPort } from '@velaros-ai/code-surface'
import { codeProgramChecker, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'
import { ShellLimits } from '@velaros-ai/velar/shell/contracts'

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
import { rehearsalSandboxRules, type SandboxDiff, sandboxOperations } from '../index'

function diffOf(overrides: Partial<SandboxDiff> = {}): SandboxDiff {
  return { sandboxId: 's1', source: '/repo', created: [], modified: [], deleted: [], gitChanged: false, textDiffs: [], omittedDiffs: 0, fingerprint: 'fp1', ...overrides }
}

/** 模型这一轮读到的能力声明：就是提交进仓的那份生成物，程序照着它过 typecheck。 */
const ModelFacingDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/code-surface/sandbox.d.ts', import.meta.url)),
  'utf8'
)

/** 一个空间的假宿主：作用域怎么钳由 clamp 决定（真 = project 那样钳在根内，假 = system 那样收任意绝对路径），端口收到的每一次调用都记下来。 */
function fakeSpace(options: { root: string; clamp: boolean; approved?: boolean }) {
  const calls: Array<Record<string, unknown>> = []
  const runs: SandboxRunOptions[] = []
  const confirmations: string[] = []
  const confirmationOptions: unknown[] = []
  const changes = diffOf({ sandboxId: 'sb-1', source: `${options.root}/src`, created: ['note.txt'], modified: ['main.ts'] })
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
      return { id: changes.sandboxId, root: `/tmp/sandboxes/${changes.sandboxId}`, source: createOptions?.source ?? options.root, createdAt: 0, network: createOptions?.network ?? false, ignored: createOptions?.ignored ?? 'link', fileCount: 3, bytes: 300, linkedDirectories: [], git: false }
    },
    runInSandbox: async (runOptions) => {
      calls.push({ runInSandbox: runOptions.command, inSandbox: runOptions.sandboxId })
      runs.push(runOptions)
      return { exitCode: 0, stdout: '3 pass 0 fail', stderr: '', durationMs: 12, timedOut: false, truncated: false, success: true }
    },
    diffSandbox: async (diffOptions) => {
      calls.push({ diffSandbox: diffOptions.sandboxId, paths: diffOptions.paths ?? null, textDiffs: diffOptions.textDiffs ?? null })
      return changes
    },
    applySandbox: async (applyOptions) => {
      calls.push({ applySandbox: applyOptions.sandboxId, fingerprint: applyOptions.fingerprint ?? null })
      return { sandboxId: applyOptions.sandboxId, created: changes.created, modified: changes.modified, deleted: changes.deleted, skippedGit: false }
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
      return { approved: options.approved !== false }
    },
  }
  return { calls, runs, confirmations, confirmationOptions, context: { abortSignal: new AbortController().signal, sandbox: port, approval } satisfies SandboxOperationContext }
}

/** 把一次能力调用转给命名空间的五个操作；抛出来的错由代码面变成模型程序里能 try/catch 的异常。 */
async function invokeOperation(operation: string, input: unknown, context: SandboxOperationContext): Promise<unknown> {
  if (operation === 'create') return sandboxOperations.create(input as SandboxCreateInput, context)
  if (operation === 'run') return sandboxOperations.run(input as SandboxRunInput, context)
  if (operation === 'diff') return sandboxOperations.diff(input as SandboxDiffInput, context)
  if (operation === 'apply') return sandboxOperations.apply(input as SandboxApplyInput, context)
  if (operation === 'discard') return sandboxOperations.discard(input as SandboxDiscardInput, context)
  throw new AppError('VALIDATION', `没有 sandbox.${operation} 这个操作。`)
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完，交出它 return 的东西。 */
async function runModelProgram(space: ReturnType<typeof fakeSpace>, source: string): Promise<unknown> {
  const capabilities: CodeCapabilityPort = {
    listOperations: () => ({ sandbox: ['create', 'run', 'diff', 'apply', 'discard'] }),
    invoke: async ({ operation, input }) => {
      try {
        return { value: await invokeOperation(operation, input, space.context) }
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return { error: { code: failure.code ?? 'UNKNOWN', message: failure.message ?? String(error) } }
      }
    },
  }
  const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities })
  const granted = [{ namespace: 'sandbox', declarations: ModelFacingDeclarations }]
  const outcome = await session.submit({ program: { source }, granted, timeoutMs: 20_000 })
  if (!outcome.checked) {
    const why = 'needsModules' in outcome ? `要先补模块 ${outcome.needsModules.join(', ')}` : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  if (outcome.result.failed) throw new Error(`程序没跑完：${outcome.result.failed.message}`)
  return outcome.result.value
}

/** 端到端那条程序：建镜像、在里面跑测试、看变化，自己算一下再决定落回还是丢弃。中间结果一个都不进上下文。 */
const EndToEndProgram = `import { create, run, diff, apply, discard } from 'velar:sandbox'

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
    const selection = rehearsalSandboxRules.prepareApply({ diff: diffOf({ created, modified: ['.ssh/config'] }) })
    expect(selection).toEqual({ created, modified: ['.ssh/config'], deleted: [], unknown: [] })
  })

  test('INV-2 点名了没有变化的路径就拒绝，什么都没写；什么都没变返回 null', () => {
    expect(() => rehearsalSandboxRules.prepareApply({ diff: diffOf({ modified: ['a.ts'] }), paths: ['a.ts', 'ghost.ts'] })).toThrow('ghost.ts')
    expect(rehearsalSandboxRules.prepareApply({ diff: diffOf() })).toBeNull()
    expect(rehearsalSandboxRules.prepareApply({ diff: diffOf({ modified: ['a.ts'], deleted: ['b.ts'] }), paths: ['./a.ts'] })).toEqual({ created: [], modified: ['a.ts'], deleted: [], unknown: [] })
  })

  test('INV-3 落回不问用户：审批端口一次都没被叫到，删除与覆盖照样落', async () => {
    const space = fakeSpace({ root: '/repo', clamp: false, approved: false })
    const applied = await sandboxOperations.apply({ id: 'sb-1' }, space.context)
    expect(applied).toEqual({ sandboxId: 'sb-1', created: ['note.txt'], modified: ['main.ts'], deleted: [], skippedGit: false })
    expect(space.confirmations).toEqual([])
    expect(space.calls.at(-1)).toEqual({ applySandbox: 'sb-1', fingerprint: 'fp1' })
  })
})

describe('代码面 sandbox 命名空间', () => {
  test('INV-5 一段真程序照生成的声明过检查，在隔离里跑完 create → run → diff → apply', async () => {
    const space = fakeSpace({ root: '/repo', clamp: true })
    const value = await runModelProgram(space, EndToEndProgram)

    // 回执就是落回的结果本身，中间那三次调用一个字都没进上下文。
    expect(value).toEqual({ sandboxId: 'sb-1', created: ['note.txt'], modified: ['main.ts'], deleted: [], skippedGit: false })
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
    const refused = await runModelProgram(clamped, `import { create } from 'velar:sandbox'

let outcome
try {
  await create({ source: '../outside' })
  outcome = '没拦住'
} catch (error) {
  outcome = { 拒绝: error.message }
}
export default outcome`)
    expect(refused).toEqual({ 拒绝: '../outside 在项目之外，沙箱只镜像项目内的目录。' })
    expect(clamped.calls.some((call) => 'createSandbox' in call)).toBe(false)

    const anywhere = fakeSpace({ root: '/home/me', clamp: false })
    const mirrored = await runModelProgram(anywhere, `import { create } from 'velar:sandbox'
const box = await create({ source: '/etc/app' })
export default box.source`)
    expect(mirrored).toBe('/etc/app')
  }, 30_000)
})

describe('镜像里的危险命令', () => {
  test('INV-7 镜像里的危险命令照常先问用户：高风险、手动、不可记忆；被拒就抛错，宿主一个进程都不起；不危险的不打扰', async () => {
    const declined = fakeSpace({ root: '/repo', clamp: true, approved: false })
    const refused = await runModelProgram(declined, `import { create, run } from 'velar:sandbox'

const box = await create({})
let outcome
try {
  await run({ id: box.id, command: 'rm -rf build' })
  outcome = '没拦住'
} catch (error) {
  outcome = { 拒绝: error.message }
}
export default outcome`)
    expect(refused).toEqual({ 拒绝: '用户没有同意。' })
    expect(declined.confirmations).toHaveLength(1)
    expect(declined.confirmations[0]).toContain('演练沙箱 sb-1 的镜像里')
    expect(declined.confirmationOptions[0]).toMatchObject({ approvalRisk: 'high', requireManualApproval: true, rememberRiskScope: false, operation: { target: '演练沙箱 sb-1' } })
    expect(declined.calls.some((call) => 'runInSandbox' in call)).toBe(false)

    const approved = fakeSpace({ root: '/repo', clamp: true })
    await sandboxOperations.run({ id: 'sb-1', command: 'rm -rf build && bun run build' }, approved.context)
    expect(approved.confirmations).toHaveLength(1)
    expect(approved.calls).toContainEqual({ runInSandbox: 'rm -rf build && bun run build', inSandbox: 'sb-1' })

    const quiet = fakeSpace({ root: '/repo', clamp: true })
    await sandboxOperations.run({ id: 'sb-1', command: 'bun test' }, quiet.context)
    expect(quiet.confirmations).toEqual([])
  }, 30_000)
})

describe('不折叠', () => {
  test('INV-8 diff 的三列永远完整、paths 只要其中几个的文本差量原样交给宿主；镜像里命令的输出只守内存的上限', async () => {
    const space = fakeSpace({ root: '/repo', clamp: false })
    await sandboxOperations.diff({ id: 'sb-1', paths: ['src/a.ts'] }, space.context)
    expect(space.calls.at(-1)).toEqual({ diffSandbox: 'sb-1', paths: ['src/a.ts'], textDiffs: null })
    await sandboxOperations.run({ id: 'sb-1', command: 'bun test' }, space.context)
    expect(space.runs.at(-1)).toMatchObject({ command: 'bun test', maxOutputChars: ShellLimits.outputChars })
    for (const hidden of ['maxFiles', 'maxOutputChars']) expect(VelarSandboxModule.declarations).not.toContain(hidden)
  })
})

describe('代码模版', () => {
  test('INV-6 代码模版整份照真实声明过类型检查；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
    const declarations = readFileSync(resolve(root, '../../../baselines/code-surface/sandbox.d.ts'), 'utf8')
    const template = readFileSync(resolve(root, 'template.js'), 'utf8')
    const checked = codeProgramChecker.check({ source: template, granted: [{ namespace: 'sandbox', declarations }] })
    expect(checked.ok ? [] : checked.diagnostics).toEqual([])
    expect(VelarSandboxModule.template).toBe(template.trim())
    expect(declarations).not.toContain('的代码模版')
  })
})

