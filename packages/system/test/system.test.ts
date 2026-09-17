import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { solidPng } from '../spec/support'
import type { SystemToolContext } from '../src/contract/requires.js'
import { SystemFileLimits } from '../src/contracts'
import { createLocalSystemKernel } from '../src/impl/LocalSystemKernel.js'
import { systemFileOperations } from '../src/impl/SystemFileOperations.js'
import { SystemGlobalSearch } from '../src/impl/SystemGlobalSearch.js'
import { buildSystemProcessConfinementSpawnSpec, buildSystemSeatbeltProfile } from '../src/utils/confinement.js'
import { isSensitiveSystemMutationPath } from '../src/utils/file-safety.js'

/** 一律批准的工具上下文：写入测试只关心内容，不走真实的用户确认。 */
const approvingContext: SystemToolContext = {
  abortSignal: new AbortController().signal,
  approval: {
    requestApproval: async () => ({ approved: true }),
    awaitConfirmation: async () => undefined,
  },
  system: { resolvePath: (path = process.cwd()) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path)) } as never,
} as SystemToolContext

/** 结果里取一项，是失败条目就抛出来，让断言直接看到原因。 */
function entryOf<T extends { path: string }>(result: { files: Array<T | { path: string; error: { code: string; message: string } }> }, index = 0): T {
  const entry = result.files[index]
  if (!entry) throw new Error(`no entry ${index}`)
  if ('error' in entry) throw new Error(`entry ${index} failed: ${entry.error.code} ${entry.error.message}`)
  return entry
}

/** 读一批，一律批准。 */
const readAll = (input: Parameters<typeof systemFileOperations.read>[0]) => systemFileOperations.read(input, approvingContext)
/** 看一批，一律批准。 */

/** 读一个文件的快捷方式。 */
async function readOne(file: { path: string; version?: string }) {
  return entryOf(await readAll({ files: [file] }))
}

/** 写一个文件的快捷方式，一律批准。 */
async function editOne(file: { path: string; newText?: string; restore?: string; version?: string }) {
  const result = await systemFileOperations.edit({ files: [file] }, approvingContext)
  const entry = result.files[0]
  if (!entry) throw new Error('no entry')
  return entry
}

/** 整批失败时回执里的问题清单，顺便核对什么都没写的标记。 */
async function problemsOf(call: Promise<unknown>) {
  try {
    await call
  } catch (error) {
    const failure = error as { context?: { executionOutcome?: string }; cause?: { reason?: string; details?: { executionOutcome?: string; problems?: Array<Record<string, unknown>> } } }
    expect(failure.context?.executionOutcome).toBe('not-applied')
    expect(failure.cause?.details?.executionOutcome).toBe('not-applied')
    return { reason: failure.cause?.reason, problems: failure.cause?.details?.problems ?? [] }
  }
  throw new Error('expected the edit to fail')
}

describe('System capability', () => {

  test('builds deterministic platform confinement profiles with an observable backend', () => {
    const policy = {
      mode: 'workspace-write' as const,
      workspaceRoot: process.cwd(),
      writeRoots: [tmpdir()],
      network: false,
    }
    const mac = buildSystemProcessConfinementSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'darwin', sandboxExecPath: '/sandbox-exec', sandboxExecAvailable: true }
    )
    const linux = buildSystemProcessConfinementSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'linux', bubblewrapPath: '/bwrap', bubblewrapAvailable: true }
    )

    // Seatbelt 只拦得住本进程的文件写，系统服务代办的事（open 按路径启动的应用、钥匙串）拦不全，证据如实报 partial。
    expect(mac.evidence).toMatchObject({
      mode: 'workspace-write',
      enforcement: 'partial',
      backend: 'seatbelt',
      reason: 'enforced-file-writes-only',
    })
    expect(mac.profile).toContain('(deny mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))')
    expect(mac.profile).toContain('(deny appleevent-send)')
    expect(mac.evidence.writableRoots).toContain(process.cwd())
    expect(mac.evidence.writableRoots).toHaveLength(2)
    expect(mac.spec.file).toBe('/sandbox-exec')
    expect(mac.profile).toBe(buildSystemSeatbeltProfile(policy))
    expect(mac.profile).toContain('(deny network*)')
    expect(mac.profile).toContain(`(subpath ${JSON.stringify(process.cwd())})`)
    expect(linux.evidence.backend).toBe('bubblewrap')
    expect(linux.spec.args).toContain('--unshare-net')
    expect(linux.spec.args).toContain(process.cwd())
  })

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'enforces real Seatbelt workspace writes and blocks writes outside the approved root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-root-'))
      const outside = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-outside-'))
      try {
        const allowedPath = join(root, 'allowed.txt')
        const deniedPath = join(outside, 'denied.txt')
        const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
        const allowed = buildSystemProcessConfinementSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf allowed > '${allowedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )
        const denied = buildSystemProcessConfinementSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf denied > '${deniedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )

        expect(spawnSync(allowed.spec.file, allowed.spec.args).status).toBe(0)
        expect(await readFile(allowedPath, 'utf8')).toBe('allowed')
        expect(spawnSync(denied.spec.file, denied.spec.args).status).not.toBe(0)
        expect(existsSync(deniedPath)).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    }
  )

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'Seatbelt blocks preference writes relayed through cfprefsd while ordinary tools keep working',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-prefs-'))
      const domain = `com.velaros.test.seatbelt-${process.pid}-${Date.now()}`
      const confined = (command: string) => {
        const built = buildSystemProcessConfinementSpawnSpec(
          { spec: { file: '/bin/sh', args: ['-c', command] }, policy: { mode: 'workspace-write', workspaceRoot: root } },
          { platform: 'darwin', tempDir: root }
        )
        return spawnSync(built.spec.file, built.spec.args, { cwd: root, encoding: 'utf8' })
      }
      try {
        // 直接写 ~/Library/Preferences 本来就被拦；经 cfprefsd 代写（defaults write）原来能写到写根之外，现在也拦住。
        expect(confined(`/usr/bin/defaults write ${domain} escaped -string yes`).status).not.toBe(0)
        expect(spawnSync('/usr/bin/defaults', ['read', domain]).status).not.toBe(0)
        // 平常的工具照常能用：git 在写根里建库、提交。
        if (Bun.which('git')) expect(confined('git init -q repo && cd repo && echo hi > a && git add a && git -c user.email=a@b -c user.name=a commit -qm i').status).toBe(0)
      } finally {
        spawnSync('/usr/bin/defaults', ['delete', domain])
        await rm(join(homedir(), 'Library', 'Preferences', `${domain}.plist`), { force: true })
        await rm(root, { recursive: true, force: true })
      }
    }
  )



  test('decodes UTF-16 text and keeps its line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-utf16-'))
    const path = join(root, 'utf16.txt')
    try {
      await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb', 'utf16le')]))
      const result = await readOne({ path })
      expect(result.content).toBe('a\r\nb')
      expect(result.encoding).toBe('utf16le')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })



  test.skipIf(process.platform === 'win32')('edit keeps an existing file mode exactly and lets umask decide the mode of a new file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-mode-'))
    const mask = process.umask(0o077)
    try {
      const shared = join(root, 'shared.sh')
      await writeFile(shared, 'echo one\n')
      await chmod(shared, 0o777)
      await editOne({ path: shared, newText: 'echo two\n' })
      expect((await stat(shared)).mode & 0o777).toBe(0o777)
      await editOne({ path: shared, newText: 'echo three\n' })
      expect((await stat(shared)).mode & 0o777).toBe(0o777)
      const fresh = join(root, 'fresh.txt')
      await editOne({ path: fresh, newText: 'new\n' })
      expect((await stat(fresh)).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(mask)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('view hands images to the model beside the result, files one or many, and refuses everything else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-view-'))
    try {
      const png = solidPng(40, 30)
      const imagePath = join(root, 'shot.png')
      await writeFile(imagePath, png)
      const attached: Array<{ mediaType: string; data: string; label: string }> = []
      const context = { ...approvingContext, attachImage: (image: { mediaType: string; data: string; label: string }) => attached.push(image) } as SystemToolContext

      const viewedImage = await systemFileOperations.view({ files: [{ path: imagePath }] }, context)
      expect(entryOf(viewedImage)).toEqual({ path: imagePath, mediaType: 'image/png', width: 40, height: 30, sent: { width: 40, height: 30 } })
      expect(attached).toEqual([{ mediaType: 'image/png', data: png.toString('base64'), label: `图片 1/1：${imagePath}（原图 40×30，给你的是 40×30）` }])
      await expect(readAll({ files: [{ path: imagePath }] })).rejects.toThrow('view')

      const pdfPath = join(root, 'report.pdf')
      await writeFile(pdfPath, Buffer.from('%PDF-1.4\n%fake\n'))
      await expect(systemFileOperations.view({ files: [{ path: pdfPath }] }, context)).rejects.toThrow('view 只看图片')
      await expect(readAll({ files: [{ path: pdfPath }] })).rejects.toThrow('不是文本')
      const textPath = join(root, 'plain.txt')
      await writeFile(textPath, 'hello')
      await expect(systemFileOperations.view({ files: [{ path: textPath }] }, context)).rejects.toThrow('read')

      // 一批里混着图片和一个不存在的文件：失败的只标记它那一项，交出的图按顺序、标签里带着它在这批里的位置。
      attached.length = 0
      const secondPath = join(root, 'again.png')
      await writeFile(secondPath, png)
      const batch = await systemFileOperations.view({ files: [{ path: imagePath }, { path: join(root, 'missing.png') }, { path: secondPath }] }, context)
      expect(batch.files.map((entry) => ('error' in entry ? entry.error.code : entry.mediaType))).toEqual(['image/png', 'NOT_FOUND', 'image/png'])
      expect(attached.map((image) => image.label.split('：')[0])).toEqual(['图片 1/3', '图片 3/3'])
      await expect(systemFileOperations.view({ files: [{ path: join(root, 'a.png') }, { path: join(root, 'b.png') }] }, context)).rejects.toThrow('不存在')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })


  test('read resolves relative paths against the host default directory, asks before credential files, and notes an exhausted budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-base-'))
    try {
      await writeFile(join(root, 'note.txt'), 'here')
      const hosted: SystemToolContext = { ...approvingContext, system: { resolvePath: (path = root) => resolve(root, path) } as never } as SystemToolContext
      expect(entryOf(await systemFileOperations.read({ files: [{ path: 'note.txt' }] }, hosted))).toMatchObject({ path: join(root, 'note.txt'), content: 'here' })

      // 凭证文件：批准就读，拒绝只算这个文件失败。
      const keyPath = join(root, 'deploy.pem')
      await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nabc\n')
      expect(entryOf(await readAll({ files: [{ path: keyPath }] })).content).toContain('PRIVATE KEY')
      const denying: SystemToolContext = { ...approvingContext, approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { throw new Error('user said no') } } } as SystemToolContext
      const refused = await systemFileOperations.read({ files: [{ path: join(root, 'note.txt') }, { path: keyPath }] }, denying)
      expect(refused.files.map((entry) => ('error' in entry ? entry.error.message : entry.content))).toEqual(['here', 'user said no'])
      await expect(systemFileOperations.read({ files: [{ path: keyPath }] }, denying)).rejects.toThrow('user said no')

      // 预算用完：后面的文件不读盘，那一项是失败条目。
      await writeFile(join(root, 'big.txt'), 'a'.repeat(SystemFileLimits.readChars))
      const budget = await readAll({ files: [{ path: join(root, 'big.txt') }, { path: join(root, 'note.txt') }] })
      expect(budget.files[1]).toMatchObject({ error: { code: 'VALIDATION' } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects directories, other binaries and device files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-reject-'))
    try {
      await expect(readAll({ files: [{ path: root }] })).rejects.toThrow('路径是目录')
      const binaryPath = join(root, 'blob.bin')
      await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]))
      await expect(readAll({ files: [{ path: binaryPath }] })).rejects.toThrow('二进制')
      if (process.platform !== 'win32') {
        await expect(readAll({ files: [{ path: '/dev/null' }] })).rejects.toThrow('不是普通文件')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })







  test('sensitive-path judgement: macOS login items are caught after case folding, temp dirs never ask, Linux has no LaunchAgents', () => {
    expect(isSensitiveSystemMutationPath('/Users/example/Library/LaunchAgents/com.evil.plist', { homeDir: '/Users/example', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/Users/example/Library/LaunchDaemons/com.evil.plist', { homeDir: '/Users/example', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/Users/example/Library/Preferences/x.plist', { homeDir: '/Users/example', platform: 'darwin' })).toBe(false)
    expect(isSensitiveSystemMutationPath('/home/someone/Library/LaunchAgents/x', { homeDir: '/home/someone', platform: 'linux' })).toBe(false)
    expect(isSensitiveSystemMutationPath('/private/var/folders/ab/T/velaros-x/note.txt', { homeDir: '/Users/example', platform: 'darwin', tempDir: '/private/var/folders/ab/T' })).toBe(false)
  })

  test('edit works on the real file behind a link, refuses the same file twice in a batch, and stops asking after the first denial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-link-'))
    try {
      const real = join(root, 'real.conf')
      await writeFile(real, 'Host a\n')
      const link = join(root, 'link.conf')
      await symlink(real, link)
      const twice = await problemsOf(systemFileOperations.edit({ files: [{ path: real, newText: 'x\n' }, { path: link, newText: 'y\n' }] }, approvingContext))
      expect(twice.problems).toEqual([expect.objectContaining({ file: 1, reason: 'invalid' })])
      expect(await readFile(real, 'utf8')).toBe('Host a\n')

      const result = await systemFileOperations.edit({ files: [{ path: link, newText: 'Host b\n' }] }, approvingContext)
      expect(result.files[0]).toMatchObject({ path: link, target: await realpath(real), action: 'written' })
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(await readFile(real, 'utf8')).toBe('Host b\n')
      // 通过链接改的版本，从真实路径和链接路径都能召回。
      const previous = (result.files[0] as { previousVersion: string }).previousVersion
      expect(entryOf(await readAll({ files: [{ path: real, version: previous }] })).content).toBe('Host a\n')

      // 第一次被拒就停：第二个凭证文件不再弹确认。
      let asked = 0
      const countingDenial: SystemToolContext = { ...approvingContext, approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { asked += 1; throw new Error('no') } } } as SystemToolContext
      const key1 = join(root, 'a.pem')
      const key2 = join(root, 'b.pem')
      await writeFile(key1, 'k1\n')
      await writeFile(key2, 'k2\n')
      const denied = await problemsOf(systemFileOperations.edit({ files: [{ path: key1, newText: 'x\n' }, { path: key2, newText: 'y\n' }] }, countingDenial))
      expect(denied.reason).toBe('SYSTEM_EDIT_DENIED')
      expect(asked).toBe(1)
      expect(denied.problems).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })



  test('global path search reports truncated only when more matches exist, and env alone is read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-search-'))
    try {
      for (const name of ['file1.txt', 'file2.txt', 'file3.txt']) await writeFile(join(root, name), name)
      const search = new SystemGlobalSearch({ platform: process.platform, homeDir: root })
      const capped = await search.search(root, { query: 'file', limit: 2 })
      expect(capped.count).toBe(2)
      expect(capped.truncated).toBe(true)
      const complete = await search.search(root, { query: 'file', limit: 3 })
      expect(complete.count).toBe(3)
      expect(complete.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })


  test.skipIf(process.platform === 'win32')('edit refuses pipes instead of hanging on them, and content search skips them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-fifo-'))
    try {
      const pipe = join(root, 'pipe')
      expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
      await writeFile(join(root, 'a.txt'), 'needle\n')
      // 原来读命名管道会一直挂着，abort 也收不回。
      // 整个写入不许把管道换成普通文件。
      const replaced = await problemsOf(systemFileOperations.edit({ files: [{ path: pipe, newText: 'x' }] }, approvingContext))
      expect(replaced.problems[0]).toMatchObject({ reason: 'invalid' })
      expect((await lstat(pipe)).isFIFO()).toBe(true)
      const found = await new SystemGlobalSearch({ platform: process.platform, homeDir: root }).search(root, { query: 'needle', mode: 'content' })
      expect(found.matches?.map((match) => match.path)).toEqual(['a.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })



  test('sensitive-path judgement covers /Applications and files directly under the root', () => {
    expect(isSensitiveSystemMutationPath('/Applications/Foo.app/Contents/MacOS/foo', { homeDir: '/Users/example', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/velaros-root-file', { homeDir: '/Users/example', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/tmp/velaros-x/file', { homeDir: '/Users/example', platform: 'darwin' })).toBe(false)
    expect(isSensitiveSystemMutationPath('/Users/example/Documents/notes.txt', { homeDir: '/Users/example', platform: 'darwin' })).toBe(false)
  })



  test.skipIf(process.platform === 'win32')('background tasks belong to their session, a missing cwd is reported as such, and dispose empties the task table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-session-'))
    const kernel = createLocalSystemKernel({ cwd: root })
    try {
      await expect(kernel.runCommand('true', { cwd: join(root, 'missing') })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const started = await kernel.runCommand('sleep 30', { background: true, sessionId: 'owner' })
      const taskId = started.backgroundProcess!.taskId!
      expect(await kernel.listBackgroundTasks({ sessionId: 'someone-else' })).toEqual([])
      expect((await kernel.listBackgroundTasks({ sessionId: 'owner' })).map((task) => task.id)).toEqual([taskId])
      await expect(kernel.terminateBackgroundTask({ taskId, sessionId: 'someone-else' })).rejects.toMatchObject({ code: 'PERMISSION' })
      const stopped = await kernel.terminateBackgroundTask({ taskId, sessionId: 'owner', force: true })
      expect(stopped.statusAfter).not.toBe('running')
      await kernel.dispose()
      expect(await kernel.listBackgroundTasks({})).toEqual([])
    } finally {
      await kernel.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
