import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { RehearsalSandboxLimits } from '@velaros-ai/velar/sandbox/contracts'

import type { LocalSystemKernelApi } from '../src/index'
import { createLocalSystemKernel, createSystemSpace } from '../src/index'
import { isPathInsideRoot } from '../src/utils/file-safety.js'
import { assertInsideSandboxBase, isSandboxId, sandboxBaseDirectory } from '../src/utils/sandbox.js'

/** 本机有没有进程约束后端：macOS 的 sandbox-exec 或 Linux 的 bubblewrap；没有就跳过要真跑命令的用例。 */
const canConfine = (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))
  || (process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

/** 造一个像项目的源目录：有 .gitignore、被忽略的 node_modules、一个假的 .git/config。 */
async function makeSource(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), 'velaros-sandbox-source-'))
  await mkdir(join(source, 'src'))
  await mkdir(join(source, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(source, '.git'))
  await writeFile(join(source, '.gitignore'), 'node_modules\n')
  await writeFile(join(source, 'src', 'a.txt'), 'alpha\nbeta\n')
  await writeFile(join(source, 'README.md'), '# demo\n')
  await writeFile(join(source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(source, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:example/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
  return source
}

/**
 * 经系统空间里真实的沙箱端口调 `velar:sandbox`，走的就是代码面那条路：程序看得见的只有返回值、错误码与说明。
 * `answer` 为 false 时每次确认都拒绝，是函数时把确认文案交给它（记下、或者趁机改镜像）再放行。
 */
function sandboxVia(kernel: LocalSystemKernelApi, answer: boolean | ((message: string) => void) = true) {
  const approval: ApprovalPort = {
    awaitConfirmation: async (message) => {
      if (answer === false) throw new Error('user said no')
      if (typeof answer === 'function') answer(message)
    },
    awaitConfirmationDecision: async () => ({ approved: answer !== false, message: null, autoApproved: false }),
  }
  const space = createSystemSpace({ host: kernel, resolveCall: (signal) => ({ abortSignal: signal ?? new AbortController().signal, approval }) })
  const port = createCapabilityPort(space.operations)
  return async <T = Record<string, unknown>>(operation: string, input: Record<string, unknown> = {}): Promise<T> => {
    const outcome = await port.invoke({ namespace: 'sandbox', operation, input })
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value as T
  }
}

describe('rehearsal sandbox', () => {
  test('sandbox ids and the base-directory guard keep deletes inside the sandbox area', async () => {
    expect(isSandboxId('20260915-183000-3fa2c1')).toBe(true)
    expect(isSandboxId('../../etc')).toBe(false)
    expect(isSandboxId('20260915-183000-3fa2c1/../..')).toBe(false)
    const base = sandboxBaseDirectory()
    await expect(assertInsideSandboxBase('/etc', base)).rejects.toMatchObject({ code: 'PERMISSION' })
    await expect(assertInsideSandboxBase(join(base, '..', 'elsewhere'), base)).rejects.toMatchObject({ code: 'PERMISSION' })
  })

  test('a filesystem root as the source is refused before anything is mirrored; containment is right for roots that end in a separator', async () => {
    expect(isPathInsideRoot('/private/var/folders/x', '/', 'darwin')).toBe(true)
    expect(isPathInsideRoot('C:\\Users\\me\\AppData\\Local\\Temp', 'C:\\', 'win32')).toBe(true)
    expect(isPathInsideRoot('/tmpfoo', '/tmp', 'linux')).toBe(false)
    const kernel = createLocalSystemKernel({ cwd: tmpdir() })
    try {
      await expect(kernel.createSandbox({ source: '/' })).rejects.toMatchObject({ code: 'VALIDATION' })
    } finally {
      await kernel.dispose()
    }
  })

  test('create refuses when there is no confinement backend and leaves no directory behind', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source, platform: 'freebsd' })
    try {
      const before = existsSync(sandboxBaseDirectory()) ? (await import('node:fs/promises')).readdir(sandboxBaseDirectory()) : Promise.resolve([])
      await expect(kernel.createSandbox({})).rejects.toMatchObject({ code: 'SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE' })
      const after = existsSync(sandboxBaseDirectory()) ? await (await import('node:fs/promises')).readdir(sandboxBaseDirectory()) : []
      expect(after.length).toBe((await before).length)
    } finally {
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('create mirrors the source with copy-on-write, links ignored directories, and cuts git push', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const created = await sandboxVia(kernel)<{ id: string; root: string; source: string; fileCount: number; linkedDirectories: string[]; git: boolean; network: boolean }>('create')
      sandboxId = created.id
      expect(isSandboxId(created.id)).toBe(true)
      expect(created.root.startsWith(sandboxBaseDirectory())).toBe(true)
      expect(created.linkedDirectories).toEqual(['node_modules'])
      expect(created.git).toBe(true)
      expect(created.network).toBe(false)
      expect(created.fileCount).toBe(4)
      expect(await readFile(join(created.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
      expect((await lstat(join(created.root, 'node_modules'))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(created.root, '.git', 'config'), 'utf8')).toContain('pushurl = DISABLED-BY-VELAROS-SANDBOX')
      expect(kernel.listSandboxes().map((record) => record.id)).toEqual([created.id])
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('ignored=copy copies what is inside the ignored directories, while ignored files outside them still stay out', async () => {
    const source = await makeSource()
    await mkdir(join(source, 'node_modules', 'dep', 'lib'), { recursive: true })
    await writeFile(join(source, 'node_modules', 'dep', 'lib', 'deep.js'), 'deep\n')
    await writeFile(join(source, '.gitignore'), 'node_modules\n.env\n')
    await writeFile(join(source, '.env'), 'SECRET=1\n')
    const kernel = createLocalSystemKernel({ cwd: source })
    const record = await kernel.createSandbox({ ignored: 'copy' })
    try {
      expect(record.linkedDirectories).toEqual([])
      expect((await lstat(join(record.root, 'node_modules'))).isSymbolicLink()).toBe(false)
      expect(await readFile(join(record.root, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
      expect(await readFile(join(record.root, 'node_modules', 'dep', 'lib', 'deep.js'), 'utf8')).toBe('deep\n')
      expect(existsSync(join(record.root, '.env'))).toBe(false)
      // 复制过来的依赖在镜像里能改（在镜像里重新构建要用）。
      const patched = await kernel.runCommand('printf patched > node_modules/dep/index.js', { cwd: record.root })
      expect(patched.exitCode).toBe(0)
      expect(await readFile(join(source, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    } finally {
      await kernel.discardSandbox(record.id)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('read-only directories mirror with their permissions, and a mirror the script made read-only can still be discarded', async () => {
    const source = await makeSource()
    await mkdir(join(source, 'vendor'))
    await writeFile(join(source, 'vendor', 'pinned.txt'), 'pinned\n')
    await chmod(join(source, 'vendor'), 0o555)
    const kernel = createLocalSystemKernel({ cwd: source })
    let sandboxId = ''
    try {
      const record = await kernel.createSandbox({})
      sandboxId = record.id
      expect(await readFile(join(record.root, 'vendor', 'pinned.txt'), 'utf8')).toBe('pinned\n')
      expect(((await stat(join(record.root, 'vendor'))).mode & 0o777).toString(8)).toBe('555')
      const locked = await kernel.runCommand('mkdir -p cache/pkg && printf x > cache/pkg/f && chmod -R a-w cache', { cwd: record.root })
      expect(locked.exitCode).toBe(0)
      expect(await kernel.discardSandbox(record.id)).toMatchObject({ removed: true })
      expect(existsSync(join(sandboxBaseDirectory(), record.id))).toBe(false)
      expect(kernel.listSandboxes()).toEqual([])
      sandboxId = ''
    } finally {
      if (sandboxId) await kernel.discardSandbox(sandboxId)
      await kernel.dispose()
      await chmod(join(source, 'vendor'), 0o755)
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('commands in the sandbox write inside it, cannot touch the source or the linked dependencies, and use a sandbox-local temp dir', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    const record = await kernel.createSandbox({})
    try {
      const inside = await kernel.runCommand('printf hi > inside.txt && printf "$TMPDIR"', { cwd: record.root })
      expect(inside.exitCode).toBe(0)
      expect(inside.stdout.startsWith(join(sandboxBaseDirectory(), record.id))).toBe(true)
      expect(await readFile(join(record.root, 'inside.txt'), 'utf8')).toBe('hi')

      const outside = await kernel.runCommand(`printf clobbered > "${join(source, 'src', 'a.txt')}"`, { cwd: record.root })
      expect(outside.exitCode).not.toBe(0)
      expect(await readFile(join(source, 'src', 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')

      const throughLink = await kernel.runCommand('printf evil > node_modules/dep/evil.js', { cwd: record.root })
      expect(throughLink.exitCode).not.toBe(0)
      expect(existsSync(join(source, 'node_modules', 'dep', 'evil.js'))).toBe(false)

      const removeSource = await kernel.runCommand(`rm -rf "${source}"`, { cwd: record.root })
      expect(removeSource.exitCode).not.toBe(0)
      expect(existsSync(join(source, 'README.md'))).toBe(true)
    } finally {
      await kernel.discardSandbox(record.id)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('diff lists created, modified and deleted files with text diffs; apply asks, writes back, and refuses conflicts', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    const record = await kernel.createSandbox({})
    try {
      await writeFile(join(record.root, 'src', 'a.txt'), 'ALPHA\nbeta\n')
      await writeFile(join(record.root, 'src', 'new.txt'), 'fresh\n')
      await rm(join(record.root, 'README.md'))
      await writeFile(join(record.root, '.git', 'HEAD'), 'ref: refs/heads/rehearsal\n')

      const changes = await sandboxVia(kernel)<{ created: string[]; modified: string[]; deleted: string[]; gitChanged: boolean; textDiffs: Array<{ path: string; diff: string }>; source: string }>('diff', { id: record.id })
      expect(changes).toMatchObject({ created: ['src/new.txt'], modified: ['src/a.txt'], deleted: ['README.md'], gitChanged: true, source: await realpath(source) })
      expect(changes.textDiffs.find((entry) => entry.path === 'src/a.txt')?.diff).toContain('-alpha')
      expect(changes.textDiffs.find((entry) => entry.path === 'src/a.txt')?.diff).toContain('+ALPHA')

      // 拒绝确认：什么都不落。
      await expect(sandboxVia(kernel, false)('apply', { id: record.id })).rejects.toThrow('user said no')
      expect(await readFile(join(source, 'src', 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
      expect(existsSync(join(source, 'README.md'))).toBe(true)

      // 批准：三列都落回，.git 不落。
      const applied = await sandboxVia(kernel)<{ created: string[]; modified: string[]; deleted: string[]; skippedGit: boolean }>('apply', { id: record.id })
      expect(applied).toMatchObject({ created: ['src/new.txt'], modified: ['src/a.txt'], deleted: ['README.md'], skippedGit: true })
      expect(await readFile(join(source, 'src', 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
      expect(await readFile(join(source, 'src', 'new.txt'), 'utf8')).toBe('fresh\n')
      expect(existsSync(join(source, 'README.md'))).toBe(false)
      expect(existsSync(join(source, '.git', 'HEAD'))).toBe(false)

      // 源文件自建沙箱以来变过（刚才落回去的就算）：再落就冲突，整批不落。
      await writeFile(join(record.root, 'src', 'a.txt'), 'ALPHA\nBETA\n')
      const conflict = await sandboxVia(kernel)('apply', { id: record.id }).then(() => null, (error: unknown) => error as { code?: string; message?: string })
      // 程序看得见的就是码和说明：冲突的路径写在说明里。
      expect(conflict?.code).toBe('SYSTEM_SANDBOX_CONFLICT')
      expect(conflict?.message).toContain('src/a.txt')
      // 上一次落回之后源目录整体都变了：新建的文件算凭空出现、改过的算变过、删掉的算丢了，宿主的错误里全部列出来。
      const detailed = await kernel.applySandbox({ sandboxId: record.id }).then(() => null, (error: unknown) => error as { context?: { executionOutcome?: string; conflicts?: Array<{ path: string; reason: string }> } })
      expect(detailed?.context?.executionOutcome).toBe('not-applied')
      expect(detailed?.context?.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/a.txt', reason: 'changed' }),
        expect.objectContaining({ path: 'src/new.txt', reason: 'appeared' }),
        expect.objectContaining({ path: 'README.md', reason: 'missing' }),
      ]))
      expect(await readFile(join(source, 'src', 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
    } finally {
      await kernel.discardSandbox(record.id)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('apply asks with the full change set: counts past the diff cap are shown, and paths that did not change are refused before asking', async () => {
    const source = await makeSource()
    const kernel = createLocalSystemKernel({ cwd: source })
    const record = await kernel.createSandbox({})
    try {
      const count = RehearsalSandboxLimits.diffFilesMax + 100
      await mkdir(join(record.root, 'many'))
      for (let index = 0; index < count; index += 1) await writeFile(join(record.root, 'many', `f${index}.txt`), 'x')
      const messages: string[] = []
      const applied = await sandboxVia(kernel, (message) => { messages.push(message) })<{ created: string[] }>('apply', { id: record.id })
      expect(messages[0]).toContain(`新增 ${count} 个`)
      expect(applied.created.length).toBe(count)

      const asked: string[] = []
      await expect(sandboxVia(kernel, (message) => { asked.push(message) })('apply', { id: record.id, paths: ['never-changed.txt'] }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
      expect(asked).toEqual([])
    } finally {
      await kernel.discardSandbox(record.id)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('apply replaces a file with a same-named directory the mirror created in its place', async () => {
    const source = await makeSource()
    await writeFile(join(source, 'docs'), 'old docs file\n')
    const kernel = createLocalSystemKernel({ cwd: source })
    const record = await kernel.createSandbox({})
    try {
      await rm(join(record.root, 'docs'))
      await mkdir(join(record.root, 'docs'))
      await writeFile(join(record.root, 'docs', 'index.md'), '# docs\n')
      await writeFile(join(record.root, 'b.txt'), 'new b\n')
      const applied = await sandboxVia(kernel)<{ created: string[]; deleted: string[] }>('apply', { id: record.id })
      expect(applied).toMatchObject({ created: ['b.txt', 'docs/index.md'], deleted: ['docs'] })
      expect((await lstat(join(source, 'docs'))).isDirectory()).toBe(true)
      expect(await readFile(join(source, 'docs', 'index.md'), 'utf8')).toBe('# docs\n')
      expect(await readFile(join(source, 'b.txt'), 'utf8')).toBe('new b\n')
    } finally {
      await kernel.discardSandbox(record.id)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('a permission-only change counts as modified, and a directory removed in the mirror leaves no empty shell behind', async () => {
    const source = await makeSource()
    await mkdir(join(source, 'build', 'nested'), { recursive: true })
    await writeFile(join(source, 'build', 'nested', 'out.js'), 'x')
    await writeFile(join(source, 'build', 'top.js'), 'y')
    await chmod(join(source, 'README.md'), 0o644)
    const kernel = createLocalSystemKernel({ cwd: source })
    const record = await kernel.createSandbox({})
    try {
      await chmod(join(record.root, 'README.md'), 0o755)
      await rm(join(record.root, 'build'), { recursive: true })
      // src 目录镜像里还在（只是空了）：源目录里也留着。
      await rm(join(record.root, 'src', 'a.txt'))
      const changes = await kernel.diffSandbox({ sandboxId: record.id })
      expect(changes.modified).toEqual(['README.md'])
      await sandboxVia(kernel)('apply', { id: record.id })
      expect(((await stat(join(source, 'README.md'))).mode & 0o777).toString(8)).toBe('755')
      expect(existsSync(join(source, 'build'))).toBe(false)
      expect(existsSync(join(source, 'src'))).toBe(true)
    } finally {
      await kernel.discardSandbox(record.id)
      await kernel.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })


  test.skipIf(!canConfine)('after a restart, simultaneous first uses of one sandbox share a single runner, so every background task stays listed and stoppable', async () => {
    const source = await makeSource()
    const first = createLocalSystemKernel({ cwd: source })
    const record = await first.createSandbox({})
    await first.dispose()
    const second = createLocalSystemKernel({ cwd: source })
    try {
      const started = await Promise.all([
        second.runCommand('sleep 20', { cwd: record.root, background: true }),
        second.runCommand('sleep 20', { cwd: record.root, background: true }),
        second.diffSandbox({ sandboxId: record.id }),
      ])
      const taskIds = started.slice(0, 2).map((result) => (result as { backgroundProcess?: { taskId?: string } }).backgroundProcess?.taskId)
      const listed = (await second.listBackgroundTasks()).map((task) => task.id)
      expect(listed).toEqual(expect.arrayContaining(taskIds as string[]))
    } finally {
      await second.discardSandbox(record.id)
      await second.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })

  test.skipIf(!canConfine)('a sandbox root survives a kernel restart: another kernel still confines commands there, and discard removes it', async () => {
    const source = await makeSource()
    const first = createLocalSystemKernel({ cwd: source })
    const record = await first.createSandbox({ network: false })
    await first.dispose()
    const second = createLocalSystemKernel({ cwd: source })
    try {
      const outside = await second.runCommand(`printf clobbered > "${join(source, 'README.md')}"`, { cwd: record.root })
      expect(outside.exitCode).not.toBe(0)
      expect(await readFile(join(source, 'README.md'), 'utf8')).toBe('# demo\n')
      const discarded = await sandboxVia(second)<{ removed: boolean }>('discard', { id: record.id })
      expect(discarded.removed).toBe(true)
      expect(existsSync(record.root)).toBe(false)
      expect(await second.discardSandbox(record.id)).toMatchObject({ removed: false })
      await expect(second.discardSandbox('../../etc')).rejects.toMatchObject({ code: 'VALIDATION' })
    } finally {
      await second.dispose()
      await rm(source, { recursive: true, force: true })
    }
  })
})
