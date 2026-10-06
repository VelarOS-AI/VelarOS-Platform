/**
 * 项目里的 `velaros:sandbox`：共用的沙箱操作配上 `projectCapabilityPorts.sandbox`——源目录钳在项目内；落回不问人，镜像里跑命令的输出原样交回。
 * 宿主的沙箱是假的（`spec/support.ts` 的 fakeSandboxHost，记下每次调用），内核是真的。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ShellLimits } from '@velaros-ai/velaros/execution/contracts'

import { createProjectPortsHarness, failureOf, fakeSandboxHost } from '../spec/support'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-sandbox-port-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 调到了宿主的哪几个动作。 */
const actions = (calls: Array<Record<string, unknown>>) =>
  calls.map((entry) => Object.keys(entry)[0])

describe('项目里的 velaros:sandbox', () => {
  test('宿主没接沙箱时每个操作都明说用不了（UNAVAILABLE），并指路改文件、跑脚本的能力', async () => {
    const { call } = await createProjectPortsHarness(root)
    for (const [operation, input] of [
      ['create', {}],
      ['run', { id: 'sb', command: 'ls' }],
      ['diff', { id: 'sb' }],
      ['apply', { id: 'sb' }],
      ['discard', { id: 'sb' }],
    ] as const) {
      const failure = await failureOf(call('sandbox', operation, input))
      expect(failure.code, operation).toBe('UNAVAILABLE')
      expect(failure.message, operation).toContain('velaros:project')
      expect(failure.message, operation).toContain('Execa')
    }
  })

  test('create 只镜像项目或项目里的目录，出了项目就拒', async () => {
    const sandbox = fakeSandboxHost(root)
    const { call } = await createProjectPortsHarness(root, { sandbox: sandbox.host })
    const whole = await call('sandbox', 'create')
    expect(whole.source).toBe(root)
    expect(sandbox.calls[0]).toEqual({ create: { source: root } })
    const sub = await call('sandbox', 'create', {
      source: 'packages/app',
      network: true,
      ignored: 'copy',
    })
    expect(sub).toMatchObject({
      source: join(root, 'packages', 'app'),
      network: true,
      ignored: 'copy',
    })
    // 源出了项目一律拒，一个镜像都不建。
    for (const source of ['../elsewhere', '/etc']) {
      const outside = await failureOf(call('sandbox', 'create', { source }))
      expect(outside.code, source).toBe('PERMISSION')
      expect(outside.message, source).toContain('项目之内')
    }
    // 名字以 .. 开头的目录在项目之内，照常接受。
    expect((await call('sandbox', 'create', { source: '..cache' })).source).toBe(
      join(root, '..cache')
    )
    expect(actions(sandbox.calls)).toEqual(['create', 'create', 'create'])
  })

  test('run 把沙箱 id 与命令原样交给宿主，回执只留模型面的字段', async () => {
    const sandbox = fakeSandboxHost(root)
    const { call } = await createProjectPortsHarness(root, { sandbox: sandbox.host })
    const ran = await call('sandbox', 'run', {
      id: 'sb',
      command: 'bun scripts/migrate.ts',
      timeoutMs: 1000,
    })
    // 输出不折叠：交给宿主的是只守内存的那个上限。
    expect(sandbox.calls).toEqual([
      {
        run: {
          sandboxId: 'sb',
          command: 'bun scripts/migrate.ts',
          timeoutMs: 1000,
          maxOutputChars: ShellLimits.outputChars,
        },
      },
    ])
    expect(ran).toEqual({
      id: 'sb',
      command: 'bun scripts/migrate.ts',
      exitCode: 0,
      stdout: 'ran',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
      success: true,
    })
  })

  test('镜像里跑危险命令也先问用户，被拒就一个进程都不起', async () => {
    const sandbox = fakeSandboxHost(root)
    const { call, confirmations } = await createProjectPortsHarness(root, {
      sandbox: sandbox.host,
      approve: false,
    })
    const refused = await failureOf(call('sandbox', 'run', { id: 'sb', command: 'rm -rf build' }))
    expect(refused.code).toBe('PERMISSION')
    expect(confirmations).toHaveLength(1)
    expect(sandbox.calls).toEqual([])
  })

  test('apply 不问人：要不附文本差量的完整三列核对点名的路径，再把差量指纹交给宿主落回', async () => {
    const sandbox = fakeSandboxHost(root, {
      diff: { modified: ['src/a.ts', 'src/api.generated.ts'] },
    })
    const { call, confirmations } = await createProjectPortsHarness(root, {
      sandbox: sandbox.host,
      approve: false,
    })
    const applied = await call('sandbox', 'apply', {
      id: 'sb',
      paths: ['src/a.ts', 'src/api.generated.ts'],
    })
    expect(applied.modified).toEqual(['src/a.ts', 'src/api.generated.ts'])
    expect(sandbox.calls.at(-2)).toEqual({ diff: { sandboxId: 'sb', textDiffs: false } })
    expect(sandbox.calls.at(-1)).toEqual({
      apply: { sandboxId: 'sb', paths: ['src/a.ts', 'src/api.generated.ts'], fingerprint: 'fp1' },
    })
    // 审批端口一次都没被叫到（它会拒）：落回照常做完。
    expect(confirmations).toEqual([])
    const unknown = await failureOf(call('sandbox', 'apply', { id: 'sb', paths: ['nope.ts'] }))
    expect(unknown.code).toBe('VALIDATION')
    expect(unknown.message).toContain('nope.ts')
  })

  test('镜像里跑命令的输出原样交回：像密钥的片段也不遮', async () => {
    const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')
    const sandbox = fakeSandboxHost(root, { stdout: `${secret}\n` })
    const { call } = await createProjectPortsHarness(root, { sandbox: sandbox.host })
    const ran = await call('sandbox', 'run', { id: 'sb', command: 'cat .env' })
    expect(ran.stdout).toBe(`${secret}\n`)
  })

  test('diff 与 discard 原样转给宿主', async () => {
    const sandbox = fakeSandboxHost(root)
    const { call } = await createProjectPortsHarness(root, { sandbox: sandbox.host })
    const changes = await call('sandbox', 'diff', { id: 'sb', paths: ['src/a.ts'] })
    expect(changes.deleted).toEqual(['old.txt'])
    const discarded = await call('sandbox', 'discard', { id: 'sb' })
    expect(discarded.removed).toBe(true)
    expect(sandbox.calls).toEqual([
      { diff: { sandboxId: 'sb', paths: ['src/a.ts'] } },
      { discard: 'sb' },
    ])
  })
})
