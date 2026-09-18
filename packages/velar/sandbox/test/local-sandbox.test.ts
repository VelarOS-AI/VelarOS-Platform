/**
 * 本机演练沙箱（`./local` 入口）的实现测试：镜像、链接与复制忽略的目录、权限、镜像里的命令、差量与落回、宿主重启之后。
 * 沙箱都建在各用例自己的临时基目录下；经 `velar:sandbox` 调的那几步走 `spec/support.ts` 里系统空间那样的端口，程序看得见的只有返回值、错误码与说明。
 */

import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createLocalSandboxHost } from '../local'
import { canConfine, discardAll, failureOf, makeScratch, removeScratch, systemSandboxSpace } from '../spec/support'
import { assertInsideSandboxBase, isPathInsideRoot, isSandboxId, sandboxBaseDirectory } from '../utils/mirror.js'

/** 造一个像项目的源目录：有 .gitignore、被忽略的 node_modules、一个假的 .git/config。 */
async function makeProjectSource(): Promise<string> {
  const source = await makeScratch('project')
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

/** 一个用例的场地：源目录、自己的沙箱基目录、建在那个基目录下的本机沙箱宿主；`close` 丢掉沙箱、删掉两个目录。 */
async function makeSite(options: { source?: string } = {}) {
  const source = options.source ?? await makeProjectSource()
  const base = await makeScratch('base')
  const host = createLocalSandboxHost({ baseDir: base })
  const close = async () => {
    await discardAll(host)
    await removeScratch(base)
    await removeScratch(source)
  }
  return { source, base, host, close }
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
    const base = await makeScratch('base')
    const host = createLocalSandboxHost({ baseDir: base })
    try {
      await expect(host.createSandbox({ source: '/' })).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(await readdir(base)).toEqual([])
    } finally {
      await host.dispose()
      await removeScratch(base)
    }
  })

  test('create wants the source the space resolved: without one, or with a relative one, it refuses instead of guessing a directory', async () => {
    const base = await makeScratch('base')
    const host = createLocalSandboxHost({ baseDir: base })
    try {
      await expect(host.createSandbox({})).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(host.createSandbox()).rejects.toMatchObject({ code: 'VALIDATION' })
      // 相对路径不拿进程的工作目录去补：那是空间 resolveSource 的事。
      await expect(host.createSandbox({ source: 'src' })).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(await readdir(base)).toEqual([])
    } finally {
      await host.dispose()
      await removeScratch(base)
    }
  })

  test('create refuses when there is no confinement backend and leaves no directory behind', async () => {
    const source = await makeProjectSource()
    const base = await makeScratch('base')
    const host = createLocalSandboxHost({ platform: 'freebsd', baseDir: base })
    try {
      await expect(host.createSandbox({ source })).rejects.toMatchObject({ code: 'SHELL_CONFINEMENT_UNAVAILABLE' })
      expect(await readdir(base)).toEqual([])
    } finally {
      await host.dispose()
      await removeScratch(base)
      await removeScratch(source)
    }
  })

  test.skipIf(!canConfine)('create mirrors the source with copy-on-write, links ignored directories, and cuts git push', async () => {
    const site = await makeSite()
    try {
      const space = systemSandboxSpace(site.host, { cwd: site.source })
      const created = await space.call<{ id: string; root: string; source: string; fileCount: number; linkedDirectories: string[]; git: boolean; network: boolean }>('create')
      expect(isSandboxId(created.id)).toBe(true)
      expect(created.source).toBe(site.source)
      expect(created.root).toBe(join(site.base, created.id, 'tree'))
      expect(created.linkedDirectories).toEqual(['node_modules'])
      expect(created.git).toBe(true)
      expect(created.network).toBe(false)
      expect(created.fileCount).toBe(4)
      expect(await readFile(join(created.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
      expect((await lstat(join(created.root, 'node_modules'))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(created.root, '.git', 'config'), 'utf8')).toContain('pushurl = DISABLED-BY-VELAROS-SANDBOX')
      expect(site.host.listSandboxes().map((record) => record.id)).toEqual([created.id])
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('ignored=copy copies what is inside the ignored directories, while ignored files outside them still stay out', async () => {
    const source = await makeProjectSource()
    await mkdir(join(source, 'node_modules', 'dep', 'lib'), { recursive: true })
    await writeFile(join(source, 'node_modules', 'dep', 'lib', 'deep.js'), 'deep\n')
    await writeFile(join(source, '.gitignore'), 'node_modules\n.env\n')
    await writeFile(join(source, '.env'), 'SECRET=1\n')
    const site = await makeSite({ source })
    try {
      const record = await site.host.createSandbox({ source, ignored: 'copy' })
      expect(record.linkedDirectories).toEqual([])
      expect((await lstat(join(record.root, 'node_modules'))).isSymbolicLink()).toBe(false)
      expect(await readFile(join(record.root, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
      expect(await readFile(join(record.root, 'node_modules', 'dep', 'lib', 'deep.js'), 'utf8')).toBe('deep\n')
      expect(existsSync(join(record.root, '.env'))).toBe(false)
      // 复制过来的依赖在镜像里能改（在镜像里重新构建要用）。
      const patched = await site.host.runInSandbox({ sandboxId: record.id, command: 'printf patched > node_modules/dep/index.js' })
      expect(patched.exitCode).toBe(0)
      expect(await readFile(join(record.root, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('patched')
      expect(await readFile(join(source, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('read-only directories mirror with their permissions, and a mirror the script made read-only can still be discarded', async () => {
    const source = await makeProjectSource()
    await mkdir(join(source, 'vendor'))
    await writeFile(join(source, 'vendor', 'pinned.txt'), 'pinned\n')
    await chmod(join(source, 'vendor'), 0o555)
    const site = await makeSite({ source })
    try {
      const record = await site.host.createSandbox({ source })
      expect(await readFile(join(record.root, 'vendor', 'pinned.txt'), 'utf8')).toBe('pinned\n')
      expect(((await stat(join(record.root, 'vendor'))).mode & 0o777).toString(8)).toBe('555')
      const locked = await site.host.runInSandbox({ sandboxId: record.id, command: 'mkdir -p cache/pkg && printf x > cache/pkg/f && chmod -R a-w cache' })
      expect(locked.exitCode).toBe(0)
      expect(await site.host.discardSandbox(record.id)).toMatchObject({ removed: true })
      expect(existsSync(join(site.base, record.id))).toBe(false)
      expect(site.host.listSandboxes()).toEqual([])
    } finally {
      await chmod(join(source, 'vendor'), 0o755)
      await site.close()
    }
  })

  test.skipIf(!canConfine)('commands in the sandbox write inside it, cannot touch the source or the linked dependencies, and use a sandbox-local temp dir', async () => {
    const site = await makeSite()
    try {
      const record = await site.host.createSandbox({ source: site.source })
      const run = (command: string) => site.host.runInSandbox({ sandboxId: record.id, command })
      const inside = await run('printf hi > inside.txt && printf "$TMPDIR"')
      expect(inside.exitCode).toBe(0)
      expect(inside.stdout).toBe(join(site.base, record.id, 'tmp'))
      expect(await readFile(join(record.root, 'inside.txt'), 'utf8')).toBe('hi')

      const outside = await run(`printf clobbered > "${join(site.source, 'src', 'a.txt')}"`)
      expect(outside.exitCode).not.toBe(0)
      expect(await readFile(join(site.source, 'src', 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')

      const throughLink = await run('printf evil > node_modules/dep/evil.js')
      expect(throughLink.exitCode).not.toBe(0)
      expect(existsSync(join(site.source, 'node_modules', 'dep', 'evil.js'))).toBe(false)

      const removeSource = await run(`rm -rf "${site.source}"`)
      expect(removeSource.exitCode).not.toBe(0)
      expect(existsSync(join(site.source, 'README.md'))).toBe(true)
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('a command runs in the foreground with the mirror root as its working directory, and its output comes back whole', async () => {
    const site = await makeSite()
    try {
      const space = systemSandboxSpace(site.host, { cwd: site.source })
      const box = await space.call<{ id: string; root: string }>('create')
      // 沙箱的执行器只跑前台命令：工作目录钉在镜像根，跑完才交回，输出原样。
      const ran = await space.call<{ success: boolean; stdout: string; id: string; command: string }>('run', { id: box.id, command: 'pwd && printf done' })
      expect(ran).toMatchObject({ id: box.id, command: 'pwd && printf done', success: true })
      expect(ran.stdout).toBe(`${box.root}\ndone`)
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('discard stops a command still running in the mirror before it deletes the mirror', async () => {
    const site = await makeSite()
    try {
      const box = await site.host.createSandbox({ source: site.source })
      const started = Date.now()
      // 命令先睡再写：丢弃要先把它停下，不许让它在删掉的目录里接着跑、事后再写出东西来。
      const running = site.host.runInSandbox({ sandboxId: box.id, command: 'sleep 20; echo late > late.txt' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await site.host.discardSandbox(box.id)).toEqual({ sandboxId: box.id, removed: true })
      const outcome = await running
      expect(outcome.success).toBe(false)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(existsSync(box.root)).toBe(false)
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('diff lists created, modified and deleted files with text diffs; apply writes back without asking, and refuses conflicts', async () => {
    const site = await makeSite()
    const { source, host } = site
    try {
      const record = await host.createSandbox({ source })
      await writeFile(join(record.root, 'src', 'a.txt'), 'ALPHA\nbeta\n')
      await writeFile(join(record.root, 'src', 'new.txt'), 'fresh\n')
      await rm(join(record.root, 'README.md'))
      await writeFile(join(record.root, '.git', 'HEAD'), 'ref: refs/heads/rehearsal\n')

      const changes = await systemSandboxSpace(host, { cwd: source }).call<{ created: string[]; modified: string[]; deleted: string[]; gitChanged: boolean; textDiffs: Array<{ path: string; diff: string }>; source: string }>('diff', { id: record.id })
      expect(changes).toMatchObject({ created: ['src/new.txt'], modified: ['src/a.txt'], deleted: ['README.md'], gitChanged: true, source })
      expect(changes.textDiffs.find((entry) => entry.path === 'src/a.txt')?.diff).toContain('-alpha')
      expect(changes.textDiffs.find((entry) => entry.path === 'src/a.txt')?.diff).toContain('+ALPHA')

      // 落回不问用户（审批端口会拒）：三列都落回，.git 不落。
      const refusing = systemSandboxSpace(host, { cwd: source, approve: false })
      const applied = await refusing.call<{ created: string[]; modified: string[]; deleted: string[]; skippedGit: boolean }>('apply', { id: record.id })
      expect(refusing.asked).toEqual([])
      expect(applied).toMatchObject({ created: ['src/new.txt'], modified: ['src/a.txt'], deleted: ['README.md'], skippedGit: true })
      expect(await readFile(join(source, 'src', 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
      expect(await readFile(join(source, 'src', 'new.txt'), 'utf8')).toBe('fresh\n')
      expect(existsSync(join(source, 'README.md'))).toBe(false)
      expect(existsSync(join(source, '.git', 'HEAD'))).toBe(false)

      // 源文件自建沙箱以来变过（刚才落回去的就算）：再落就冲突，整批不落。
      await writeFile(join(record.root, 'src', 'a.txt'), 'ALPHA\nBETA\n')
      const conflict = await failureOf(refusing.call('apply', { id: record.id }))
      // 程序看得见的就是码和说明：冲突的路径写在说明里。
      expect(conflict.code).toBe('SANDBOX_CONFLICT')
      expect(conflict.message).toContain('src/a.txt')
      // 上一次落回之后源目录整体都变了：新建的文件算凭空出现、改过的算变过、删掉的算丢了，宿主的错误里全部列出来。
      const detailed = await failureOf(host.applySandbox({ sandboxId: record.id }))
      expect(detailed.context.executionOutcome).toBe('not-applied')
      expect(detailed.context.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/a.txt', reason: 'changed' }),
        expect.objectContaining({ path: 'src/new.txt', reason: 'appeared' }),
        expect.objectContaining({ path: 'README.md', reason: 'missing' }),
      ]))
      expect(await readFile(join(source, 'src', 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('diff lists every change and apply writes the full change set; paths that did not change are refused', async () => {
    const site = await makeSite()
    try {
      const record = await site.host.createSandbox({ source: site.source })
      const count = 2_100
      await mkdir(join(record.root, 'many'))
      for (let index = 0; index < count; index += 1) await writeFile(join(record.root, 'many', `f${index}.txt`), 'x')
      // 三列不截断：看多少由程序定。
      const listed = await site.host.diffSandbox({ sandboxId: record.id, textDiffs: false })
      expect(listed.created).toHaveLength(count)
      const space = systemSandboxSpace(site.host, { cwd: site.source, approve: false })
      const applied = await space.call<{ created: string[] }>('apply', { id: record.id })
      expect(applied.created.length).toBe(count)

      expect(await failureOf(space.call('apply', { id: record.id, paths: ['never-changed.txt'] }))).toMatchObject({ code: 'VALIDATION' })
      expect(space.asked).toEqual([])
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('apply replaces a file with a same-named directory the mirror created in its place', async () => {
    const source = await makeProjectSource()
    await writeFile(join(source, 'docs'), 'old docs file\n')
    const site = await makeSite({ source })
    try {
      const record = await site.host.createSandbox({ source })
      await rm(join(record.root, 'docs'))
      await mkdir(join(record.root, 'docs'))
      await writeFile(join(record.root, 'docs', 'index.md'), '# docs\n')
      await writeFile(join(record.root, 'b.txt'), 'new b\n')
      const applied = await systemSandboxSpace(site.host, { cwd: source }).call<{ created: string[]; deleted: string[] }>('apply', { id: record.id })
      expect(applied).toMatchObject({ created: ['b.txt', 'docs/index.md'], deleted: ['docs'] })
      expect((await lstat(join(source, 'docs'))).isDirectory()).toBe(true)
      expect(await readFile(join(source, 'docs', 'index.md'), 'utf8')).toBe('# docs\n')
      expect(await readFile(join(source, 'b.txt'), 'utf8')).toBe('new b\n')
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('a permission-only change counts as modified, and a directory removed in the mirror leaves no empty shell behind', async () => {
    const source = await makeProjectSource()
    await mkdir(join(source, 'build', 'nested'), { recursive: true })
    await writeFile(join(source, 'build', 'nested', 'out.js'), 'x')
    await writeFile(join(source, 'build', 'top.js'), 'y')
    await chmod(join(source, 'README.md'), 0o644)
    const site = await makeSite({ source })
    try {
      const record = await site.host.createSandbox({ source })
      await chmod(join(record.root, 'README.md'), 0o755)
      await rm(join(record.root, 'build'), { recursive: true })
      // src 目录镜像里还在（只是空了）：源目录里也留着。
      await rm(join(record.root, 'src', 'a.txt'))
      const changes = await site.host.diffSandbox({ sandboxId: record.id })
      expect(changes.modified).toEqual(['README.md'])
      await systemSandboxSpace(site.host, { cwd: source }).call('apply', { id: record.id })
      expect(((await stat(join(source, 'README.md'))).mode & 0o777).toString(8)).toBe('755')
      expect(existsSync(join(source, 'build'))).toBe(false)
      expect(existsSync(join(source, 'src'))).toBe(true)
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('after a restart, simultaneous first uses of one sandbox load it once: commands, the diff and the listing all see the same sandbox', async () => {
    const site = await makeSite()
    const first = createLocalSandboxHost({ baseDir: site.base })
    const record = await first.createSandbox({ source: site.source })
    await first.dispose()
    try {
      // 界面看差量、模型跑命令，同时第一次用到重启前建的沙箱：共用同一次加载，都成，登记只有一份。
      const [one, two, changes] = await Promise.all([
        site.host.runInSandbox({ sandboxId: record.id, command: 'printf one > one.txt' }),
        site.host.runInSandbox({ sandboxId: record.id, command: 'printf two > two.txt' }),
        site.host.diffSandbox({ sandboxId: record.id }),
      ])
      expect([one.exitCode, two.exitCode]).toEqual([0, 0])
      expect(changes.sandboxId).toBe(record.id)
      expect(site.host.listSandboxes().map((listed) => listed.id)).toEqual([record.id])
      expect((await site.host.diffSandbox({ sandboxId: record.id, textDiffs: false })).created).toEqual(['one.txt', 'two.txt'])
    } finally {
      await site.close()
    }
  })

  test.skipIf(!canConfine)('a sandbox root survives a host restart: another host still confines commands there, and discard removes it', async () => {
    const site = await makeSite()
    const first = createLocalSandboxHost({ baseDir: site.base })
    const record = await first.createSandbox({ source: site.source, network: false })
    await first.dispose()
    try {
      const outside = await site.host.runInSandbox({ sandboxId: record.id, command: `printf clobbered > "${join(site.source, 'README.md')}"` })
      expect(outside.exitCode).not.toBe(0)
      expect(await readFile(join(site.source, 'README.md'), 'utf8')).toBe('# demo\n')
      const discarded = await systemSandboxSpace(site.host, { cwd: site.source }).call<{ removed: boolean }>('discard', { id: record.id })
      expect(discarded.removed).toBe(true)
      expect(existsSync(record.root)).toBe(false)
      expect(await site.host.discardSandbox(record.id)).toMatchObject({ removed: false })
      await expect(site.host.discardSandbox('../../etc')).rejects.toMatchObject({ code: 'VALIDATION' })
    } finally {
      await site.close()
    }
  })
})
