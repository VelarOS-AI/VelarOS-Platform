/**
 * 项目空间的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 改动或删除已有用例要在差量报告里点名并说明理由。这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 一律经代码面的能力端口调（和模型的程序是同一条路），断言程序看得到的 code 与 message。
 * 两件项目工具自己的承诺（fileRef、事务、撤销、编码……）在 `@velaros-ai/velar/project` 的验收里测，这里只测空间的装配与三件共用能力的项目端口。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createProjectHarness, failureOf, pngHeader } from './support'

/** 生成的声明所在的目录。 */
const Baselines = resolve(import.meta.dir, '../../../baselines/code-surface')

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-space-acceptance-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('装配', () => {
  test('INV-1 项目空间挂五个命名空间；模块清单正好是这五件，声明是各单元随包发布的那一份，放出的方法就是能调的那些；常驻的是项目文件与命令', async () => {
    const { space } = await createProjectHarness(root)
    const table = space.operations
    expect(Object.keys(table).sort()).toEqual(['code', 'images', 'project', 'sandbox', 'shell'])
    expect(space.modules.map(({ surface }) => surface.namespace).sort()).toEqual(Object.keys(table).sort())
    for (const { surface } of space.modules) {
      expect(surface.specifier).toBe(`velar:${surface.namespace}`)
      expect(surface.declarations).toBe(await readFile(join(Baselines, `${surface.namespace}.d.ts`), 'utf8'))
      expect([...surface.methods].sort()).toEqual(Object.keys(table[surface.namespace]!).sort())
    }
    expect(space.modules.filter((module) => module.resident).map(({ surface }) => surface.namespace)).toEqual(['project', 'shell'])
  })
})

describe('共用能力的项目端口', () => {
  test('INV-2 危险命令每次都由用户亲自确认；被拒一个进程都不起；会改项目的命令先过修改授权，只读命令不打扰', async () => {
    const denied = await createProjectHarness(root, { approve: false })
    expect((await failureOf(denied.call('shell', 'run', { command: 'rm -rf ./dist' }))).code).toBe('PERMISSION')
    expect(denied.commands).toEqual([])
    expect(denied.confirmations[0]?.options).toMatchObject({ approvalRisk: 'high', requireManualApproval: true, rememberRiskScope: false, riskScope: 'project-command:dangerous' })

    const unauthorized = await createProjectHarness(root, { authorizeMutation: false })
    expect((await failureOf(unauthorized.call('shell', 'run', { command: 'touch created.txt' }))).code).toBe('PERMISSION')
    expect(unauthorized.mutations).toHaveLength(1)
    expect(unauthorized.commands).toEqual([])

    const readOnly = await createProjectHarness(root, { authorizeMutation: false })
    await readOnly.call('shell', 'run', { command: 'ls' })
    expect(readOnly.mutations).toEqual([])
    expect(readOnly.commands).toEqual(['ls'])
  })

  test('INV-3 命令的工作目录与沙箱的源目录钳在项目内：出了项目在问用户之前就拒绝', async () => {
    const outside = await createProjectHarness(root)
    expect((await failureOf(outside.call('shell', 'run', { command: 'ls', cwd: '..' }))).code).toBe('PERMISSION')
    expect(outside.confirmations).toEqual([])
    expect(outside.mutations).toEqual([])
    expect(outside.commands).toEqual([])

    const sandboxed = await createProjectHarness(root, { sandbox: { createSandbox: async () => { throw new Error('不该建到这里') } } as never })
    expect((await failureOf(sandboxed.call('sandbox', 'create', { source: '..' }))).code).toBe('PERMISSION')
  })

  test('INV-4 演练沙箱落回过同一套写治理：有一条不许写就在问用户之前整批拒绝，一个文件都不落', async () => {
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
    const failure = await failureOf(call('sandbox', 'apply', { id: 'sb' }))
    expect(failure.code).toBe('PERMISSION')
    expect(failure.message).toContain('deploy.key')
    // 拒绝发生在修改授权与用户确认之前，宿主一个文件都没落。
    expect(mutations).toEqual([])
    expect(confirmations).toEqual([])
    expect(applied).toEqual([])
    // 点名只落许写的那一个，照常落回。
    await call('sandbox', 'apply', { id: 'sb', paths: ['notes.txt'] })
    expect(applied).toHaveLength(1)
  })

  test('INV-5 项目空间里看图只看项目里、读取策略许看的图', async () => {
    await writeFile(join(root, 'shot.png'), pngHeader(40, 30))
    await writeFile(join(root, 'private.png'), pngHeader(10, 10))
    const outside = await mkdtemp(join(tmpdir(), 'project-space-acceptance-image-'))
    try {
      await writeFile(join(outside, 'far.png'), pngHeader(10, 10))
      const { call, attached } = await createProjectHarness(root, { corePolicy: { readDeny: ['private.png'] } })
      const seen = await call('images', 'view', { files: [{ path: 'shot.png' }] })
      expect(seen.files[0]).toMatchObject({ path: 'shot.png', width: 40, height: 30 })
      expect(attached).toHaveLength(1)
      expect((await failureOf(call('images', 'view', { files: [{ path: 'private.png' }] }))).code).toBe('PERMISSION')
      expect((await failureOf(call('images', 'view', { files: [{ path: join(outside, 'far.png') }] }))).code).toBe('PERMISSION')
      expect(attached).toHaveLength(1)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
