/**
 * 项目空间的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 改动或删除已有用例要在差量报告里点名并说明理由。这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { DefaultToolContractExampleRegistry } from '@velaros-ai/agent/tool-contract'

import { ProjectToolNames, projectTools } from '../src/exports/index'
import { ProjectExecutionGate } from '../src/impl/operations/ProjectExecutionGate'

import { createProjectHarness } from './support'

/** UTF-8 的 BOM。 */
const Bom = String.fromCharCode(0xfeff)

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-acceptance-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('工具面', () => {
  test('INV-1 只有七个工具，名字来自 ProjectToolNames，每个工具的 schema 拒收未知字段', () => {
    expect(Object.keys(projectTools).sort()).toEqual(Object.values(ProjectToolNames).sort())
    for (const tool of Object.values(projectTools)) {
      const example = DefaultToolContractExampleRegistry.get(tool.name ?? '')?.[0]
      expect({ tool: tool.name, example: !!example }).toEqual({ tool: tool.name, example: true })
      expect(tool.schema.safeParse(example).success).toBe(true)
      expect(tool.schema.safeParse({ ...example, unexpectedField: 1 }).success).toBe(false)
    }
  })
})

describe('编辑的边界', () => {
  test('INV-2 fileRef 只覆盖模型看到的那几行，range 越出去整批拒绝、文件不变', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('a.txt', 2)
    expect(view.fileRef).toStartWith('view:')
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', range: 3, text: 'bad' }] }] }))
      .rejects.toMatchObject({ reason: 'SCOPE_VIOLATION', details: { executionOutcome: 'not-applied' } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nsecond\nthird\n')
  })

  test('INV-3 读取之后被外部改过，基于旧版本的编辑整批拒绝，不覆盖外部改动', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    const { call, read } = await createProjectHarness(root)
    const view = await read('a.txt')
    await writeFile(join(root, 'a.txt'), 'one\nchanged outside\n')
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'edit', fileRef: view.fileRef, edits: [{ op: 'replace', range: 2, text: 'mine' }] }] }))
      .rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH', details: { executionOutcome: 'not-applied' } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\nchanged outside\n')
  })

  test('INV-4 两个文件一起改，一处定不下来就全不改，回执标 not-applied', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n')
    const { call, read } = await createProjectHarness(root)
    const a = await read('a.txt')
    const b = await read('b.txt')
    await expect(call('project:edit', { action: 'apply', steps: [
      { action: 'edit', fileRef: a.fileRef, edits: [{ op: 'replace', range: 1, text: 'ALPHA' }] },
      { action: 'edit', fileRef: b.fileRef, edits: [{ op: 'replace', match: 'not in the file', text: 'x' }] },
    ] })).rejects.toMatchObject({ details: { executionOutcome: 'not-applied' } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta\n')
  })

  test('INV-5 撤销遇到之后的外部修改拒绝覆盖', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const { call, read } = await createProjectHarness(root)
    const edited = await call('project:edit', { action: 'apply', steps: [{ action: 'edit', fileRef: (await read('a.txt')).fileRef, edits: [{ op: 'replace', range: 1, text: 'two' }] }] })
    expect(edited.changeRef).toStartWith('change:')
    await writeFile(join(root, 'a.txt'), 'three\n')
    await expect(call('project:edit', { action: 'undo', changeRef: edited.changeRef }))
      .rejects.toMatchObject({ reason: 'CONFLICT_WITH_EXTERNAL_EDIT', details: { executionOutcome: 'not-applied' } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three\n')
  })

  test('INV-6 越出项目的路径一律拒绝，包括经符号链接指到项目外', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'project-acceptance-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside\n')
      await symlink(outside, join(root, 'link'))
      const { call } = await createProjectHarness(root)
      await expect(call('project:read', { files: [{ path: '../secret.txt' }] })).rejects.toThrow()
      await expect(call('project:read', { files: [{ path: 'link/secret.txt' }] })).rejects.toThrow()
      await expect(call('project:edit', { action: 'apply', steps: [{ action: 'create', path: 'link/new.txt', text: 'x\n' }] })).rejects.toThrow()
      await expect(readFile(join(outside, 'new.txt'))).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-9 文本改动保留原来的 BOM 与换行，没改到的字节不动；新建文件是无 BOM 的 UTF-8、LF', async () => {
    await writeFile(join(root, 'crlf.txt'), Buffer.from(`${Bom}one\r\ntwo\r\nthree\r\n`, 'utf8'))
    const { call, read } = await createProjectHarness(root)
    await call('project:edit', { action: 'apply', steps: [{ action: 'edit', fileRef: (await read('crlf.txt')).fileRef, edits: [{ op: 'replace', range: 2, text: 'TWO' }] }] })
    expect([...await readFile(join(root, 'crlf.txt'))]).toEqual([...Buffer.from(`${Bom}one\r\nTWO\r\nthree\r\n`, 'utf8')])
    await call('project:edit', { action: 'apply', steps: [{ action: 'create', path: 'fresh.txt', text: 'a\nb\n' }] })
    expect([...await readFile(join(root, 'fresh.txt'))]).toEqual([...Buffer.from('a\nb\n', 'utf8')])
  })

  test('INV-13 同一个物理文件的项目内别名算同一个文件：一次编辑里出现两次整批拒绝，拒读名单按真实路径判', async () => {
    await writeFile(join(root, 'real.txt'), 'L1\nL2\n')
    await symlink('real.txt', join(root, 'link.txt'))
    const { call, read } = await createProjectHarness(root)
    const linkView = await read('link.txt')
    const realView = await read('real.txt')
    await expect(call('project:edit', { action: 'apply', steps: [
      { action: 'edit', fileRef: linkView.fileRef, edits: [{ op: 'replace', range: 1, text: 'A' }] },
      { action: 'edit', fileRef: realView.fileRef, edits: [{ op: 'replace', range: 2, text: 'B' }] },
    ] })).rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { executionOutcome: 'not-applied' } })
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('L1\nL2\n')

    await writeFile(join(root, '.env'), 'API_KEY=sk-live-SECRET\n')
    await symlink('.env', join(root, 'env.sample'))
    const denied = await createProjectHarness(root, { corePolicy: { readDeny: ['.env'] } })
    await expect(denied.call('project:read', { files: [{ path: '.env' }] })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
    await expect(denied.call('project:read', { files: [{ path: 'env.sample' }] })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
  })

  test('INV-14 版本库内部缺省不许写，报错说清楚该用 project:run', async () => {
    const { call } = await createProjectHarness(root)
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'create', path: '.git/hooks/pre-commit', text: '#!/bin/sh\n' }] }))
      .rejects.toMatchObject({ reason: 'PERMISSION_DENIED', suggestedNextAction: expect.stringContaining('project:run') })
    await expect(readFile(join(root, '.git/hooks/pre-commit'))).rejects.toThrow()
  })

  test('INV-10 命中 generatedFiles 的文件不许手改，下一步是改生成器的输入再重新生成', async () => {
    const { call } = await createProjectHarness(root)
    await expect(call('project:edit', { action: 'apply', steps: [{ action: 'create', path: 'src/api.generated.ts', text: 'export {}\n' }] }))
      .rejects.toMatchObject({ reason: 'GENERATED_FILE', suggestedNextAction: expect.stringContaining('project:run') })
    await expect(readFile(join(root, 'src/api.generated.ts'))).rejects.toThrow()
  })

  test('INV-16 演练沙箱落回过同一套写治理：有一条不许写就在问用户之前整批拒绝，一个文件都不落', async () => {
    const applied: unknown[] = []
    const sandbox = {
      createSandbox: async () => ({ id: 'sb', root: join(root, '.mirror'), source: root, createdAt: 1, network: false, ignored: 'link' as const, fileCount: 1, bytes: 1, linkedDirectories: [], git: false }),
      runInSandbox: async () => { throw new Error('用不到') },
      diffSandbox: async () => ({ sandboxId: 'sb', source: root, created: ['src/api.generated.ts'], modified: ['notes.txt'], deleted: ['deploy.key'], truncated: false, gitChanged: false, textDiffs: [], omittedDiffs: 0, fingerprint: 'fp' }),
      applySandbox: async (options: unknown) => { applied.push(options); return { sandboxId: 'sb', created: [], modified: [], deleted: [], skippedGit: false } },
      discardSandbox: async () => ({ sandboxId: 'sb', removed: true }),
    }
    await writeFile(join(root, 'notes.txt'), 'notes\n')
    const { call, confirmations, mutations } = await createProjectHarness(root, { sandbox: sandbox as never, corePolicy: { writeDeny: ['deploy.key'] } })
    await expect(call('project:sandbox', { action: 'apply', sandboxId: 'sb' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
    // 生成文件与 writeDeny 的路径都点名了；拒绝发生在修改授权与用户确认之前，宿主一个文件都没落。
    expect(mutations).toEqual([])
    expect(confirmations).toEqual([])
    expect(applied).toEqual([])
    // 去掉不许写的两条之后，剩下的照常落回。
    await call('project:sandbox', { action: 'apply', sandboxId: 'sb', paths: ['notes.txt'] })
    expect(applied).toHaveLength(1)
  })
})

describe('命令', () => {
  test('INV-7 危险命令每次都由用户亲自确认；被拒不执行；会改项目的命令先过修改授权', async () => {
    const denied = await createProjectHarness(root, { approve: false })
    const result = await denied.call('project:run', { command: 'rm -rf ./dist' })
    expect(result).toMatchObject({ approved: false, skipped: true })
    expect(denied.commands).toEqual([])
    expect(denied.confirmations[0]?.options).toMatchObject({ approvalRisk: 'high', requireManualApproval: true, rememberRiskScope: false, riskScope: 'project-command:dangerous' })
    expect(String((denied.confirmations[0]?.options?.operation as { key?: string } | undefined)?.key)).toStartWith('shell-command:')

    const unauthorized = await createProjectHarness(root, { authorizeMutation: false })
    const skipped = await unauthorized.call('project:run', { command: 'touch created.txt' })
    expect(skipped).toMatchObject({ approved: false, skipped: true })
    expect(unauthorized.mutations).toHaveLength(1)
    expect(unauthorized.commands).toEqual([])

    const readOnly = await createProjectHarness(root, { authorizeMutation: false })
    await readOnly.call('project:run', { command: 'ls' })
    expect(readOnly.mutations).toEqual([])
    expect(readOnly.commands).toEqual(['ls'])
  })

  test('INV-17 修改授权带着这次要写的文件问，而且问在写之前；命令的 cwd 出了项目先拒绝，不打扰用户', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const harness = await createProjectHarness(root)
    const file = await harness.read('a.txt')
    await harness.call('project:edit', { action: 'apply', steps: [
      { action: 'create', path: 'created.txt', text: 'new\n' },
      { action: 'edit', fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'ALPHA' }] },
    ] })
    // 先规划、再带着路径问授权：确认卡片列得出这次会写哪些文件。
    expect(harness.mutations).toEqual(['变更项目文件'])
    expect([...harness.authorizedPaths[0]!].sort()).toEqual(['a.txt', 'created.txt'])

    const outside = await createProjectHarness(root)
    await expect(outside.call('project:run', { command: 'ls', cwd: '..' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
    expect(outside.confirmations).toEqual([])
    expect(outside.mutations).toEqual([])
    expect(outside.commands).toEqual([])
  })

  test('INV-8 同一项目根上写串行、读并发；排队的写者不被后来的读者饿死；取消了的等待者不运行', async () => {
    const gate = new ProjectExecutionGate()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstRead = gate.run('/repo', false, new AbortController().signal, () => new Promise<void>((resolve) => { order.push('read-1 start'); releaseFirst = resolve }))
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
