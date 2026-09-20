import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createLocalShellHost } from '../../impl/local/LocalShellHost.js'
import { buildConfinedSpawnSpec, buildSeatbeltProfile } from '../../utils/confinement.js'

describe('Local shell host', () => {

  test('builds deterministic platform confinement profiles with an observable backend', () => {
    const policy = {
      mode: 'workspace-write' as const,
      workspaceRoot: process.cwd(),
      writeRoots: [tmpdir()],
      network: false,
    }
    const mac = buildConfinedSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'darwin', sandboxExecPath: '/sandbox-exec', sandboxExecAvailable: true }
    )
    const linux = buildConfinedSpawnSpec(
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
    expect(mac.profile).toBe(buildSeatbeltProfile(policy))
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
        const allowed = buildConfinedSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf allowed > '${allowedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )
        const denied = buildConfinedSpawnSpec(
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
        const built = buildConfinedSpawnSpec(
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



  test.skipIf(process.platform === 'win32')('background tasks belong to their session, a missing cwd is reported as such, and dispose empties the task table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-session-'))
    const kernel = createLocalShellHost({ cwd: root })
    try {
      await expect(kernel.runCommand('true', { cwd: join(root, 'missing') })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const started = await kernel.runCommand('sleep 30', { background: true, sessionId: 'owner' })
      const taskId = started.backgroundProcess!.taskId!
      expect(await kernel.listBackgroundTasks({ sessionId: 'someone-else' })).toEqual([])
      expect((await kernel.listBackgroundTasks({ sessionId: 'owner' })).map((task) => task.id)).toEqual([taskId])
      await expect(kernel.terminateBackgroundTask({ taskId, sessionId: 'someone-else', force: false })).rejects.toMatchObject({ code: 'PERMISSION' })
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
