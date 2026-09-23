/**
 * 项目端口接真的本机宿主：`ProjectHostPort` 跑命令、管后台任务的四件来自本机 shell 宿主（`@velaros-ai/velaros/shell/local`），
 * 演练沙箱来自本机演练沙箱（`@velaros-ai/velaros/sandbox/local`）——产品装项目空间时就是这样接的。
 * 命令真在项目里跑、越界的工作目录一个进程都不起；沙箱真镜像项目，镜像里的命令写不到项目里，落回不问人。
 */

import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { LocalSandboxHostApi } from '@velaros-ai/velaros/sandbox'
import { createLocalSandboxHost } from '@velaros-ai/velaros/sandbox/local'
import type { LocalShellHostApi } from '@velaros-ai/velaros/shell'
import { createLocalShellHost } from '@velaros-ai/velaros/shell/local'

import { createProjectPortsHarness, failureOf } from '../spec/support'

/** 本机有没有进程约束后端：macOS 的 sandbox-exec 或 Linux 的 bubblewrap；没有就建不出沙箱。 */
const canConfine =
  (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
  (process.platform === 'linux' &&
    ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

let root = ''
let outside = ''
let sandboxBase = ''
let shellHost: LocalShellHostApi
let sandboxHost: LocalSandboxHostApi
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-local-hosts-'))
  outside = await mkdtemp(join(tmpdir(), 'project-local-hosts-outside-'))
  sandboxBase = await mkdtemp(join(tmpdir(), 'project-local-hosts-sandboxes-'))
  shellHost = createLocalShellHost({ cwd: root })
  sandboxHost = createLocalSandboxHost({ baseDir: sandboxBase })
})
afterEach(async () => {
  for (const record of sandboxHost.listSandboxes()) await sandboxHost.discardSandbox(record.id)
  await sandboxHost.dispose()
  await shellHost.dispose()
  for (const directory of [root, outside, sandboxBase])
    await rm(directory, { recursive: true, force: true })
})

/** 项目宿主：命令与后台任务交给本机 shell 宿主，沙箱交给本机演练沙箱。 */
async function projectOnLocalHosts(options: { approve?: boolean } = {}) {
  const harness = await createProjectPortsHarness(root, {
    approve: options.approve,
    runCommand: (command, runOptions, allowDangerous, signal) =>
      shellHost.runCommand(command, runOptions, allowDangerous, signal),
    sandbox: sandboxHost,
  })
  harness.host.listBackgroundTasks = (query) => shellHost.listBackgroundTasks(query)
  harness.host.terminateBackgroundTask = (request) => shellHost.terminateBackgroundTask(request)
  harness.host.refreshShellEnvironment = () => shellHost.refreshShellEnvironment()
  return harness
}

describe('项目端口接本机宿主', () => {
  test.skipIf(process.platform === 'win32')(
    '命令真在项目里跑：相对工作目录落在项目里，越出项目（含经符号链接）的一个进程都不起',
    async () => {
      await mkdir(join(root, 'src'))
      await symlink(outside, join(root, 'escape'))
      const { call, confirmations } = await projectOnLocalHosts()
      const made = await call('shell', 'run', { command: 'printf hi > made.txt' })
      expect(made).toMatchObject({ success: true, cwd: root })
      expect(await readFile(join(root, 'made.txt'), 'utf8')).toBe('hi')
      const inSrc = await call('shell', 'run', { command: 'printf there > here.txt', cwd: 'src' })
      expect(inSrc).toMatchObject({ success: true, cwd: join(root, 'src') })
      expect(await readFile(join(root, 'src', 'here.txt'), 'utf8')).toBe('there')
      for (const cwd of ['escape', outside, '..']) {
        expect(
          (await failureOf(call('shell', 'run', { command: 'printf x > leaked.txt', cwd }))).code
        ).toBe('PERMISSION')
      }
      expect(await readdir(outside)).toEqual([])
      expect(confirmations).toEqual([])
    }
  )

  test.skipIf(process.platform === 'win32')(
    '后台任务交给本机宿主，按本会话列、按本会话停',
    async () => {
      const { call } = await projectOnLocalHosts()
      const started = await call('shell', 'run', { command: 'sleep 30', background: true })
      const taskId = started.backgroundProcess?.taskId as string
      expect(taskId).toBeTruthy()
      const listed = await call('shell', 'listTasks', { taskId })
      expect(
        listed.tasks.map((task: { id: string; status: string }) => [task.id, task.status])
      ).toEqual([[taskId, 'running']])
      expect(await call('shell', 'stop', { taskId, force: true })).toMatchObject({
        taskId,
        stopped: true,
      })
    }
  )

  test.skipIf(!canConfine)(
    '项目的演练沙箱镜像项目：镜像里的命令写不到项目里，差量看得见，落回不问人',
    async () => {
      await writeFile(join(root, 'a.txt'), 'alpha\n')
      const { call, confirmations } = await projectOnLocalHosts({ approve: false })
      const box = await call('sandbox', 'create')
      expect(box.source).toBe(await realpath(root))
      const inside = await call('sandbox', 'run', { id: box.id, command: 'printf beta > b.txt' })
      expect(inside.success).toBe(true)
      const escaped = await call('sandbox', 'run', {
        id: box.id,
        command: `printf x > "${join(root, 'a.txt')}"`,
      })
      expect(escaped.success).toBe(false)
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
      const changes = await call('sandbox', 'diff', { id: box.id })
      expect(changes).toMatchObject({ created: ['b.txt'], modified: [], deleted: [] })
      const applied = await call('sandbox', 'apply', { id: box.id })
      expect(applied.created).toEqual(['b.txt'])
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta')
      expect(await call('sandbox', 'discard', { id: box.id })).toMatchObject({ removed: true })
      // 审批端口会拒，却一次都没被叫到：建、跑不危险的命令、看差量、落回、丢弃都不问人。
      expect(confirmations).toEqual([])
    }
  )
})
