import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { executeAtomicRead } from '../src/atomic/Read'
import { executeAtomicWrite, resolveAtomicWriteContent } from '../src/atomic/Write'
import { systemTools } from '../src/Collection'
import { SystemToolNames } from '../src/system-tool-names'
import {
  analyzeCommandExecution,
  isParallelCommandExecutionSafe,
  isSystemShellCommandReadOnly,
  shouldReapForegroundProcessGroupAfterExit,
} from '../src/SystemCommandExecutionPolicy'
import {
  buildSystemProcessConfinementSpawnSpec,
  buildSystemSeatbeltProfile,
} from '../src/SystemProcessConfinement'

describe('System capability', () => {
  test('reports explicit full access instead of pretending an unconfined process is sandboxed', () => {
    const result = buildSystemProcessConfinementSpawnSpec({
      spec: { file: '/bin/sh', args: ['-lc', 'true'] },
      policy: { mode: 'danger-full-access', workspaceRoot: '/workspace' },
    })

    expect(result.spec).toEqual({ file: '/bin/sh', args: ['-lc', 'true'] })
    expect(result.evidence).toEqual({
      mode: 'danger-full-access',
      enforcement: 'none',
      backend: 'none',
      reason: 'explicit-danger-full-access',
      writableRoots: [],
    })
  })

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

    expect(mac.evidence).toMatchObject({
      mode: 'workspace-write',
      enforcement: 'full',
      backend: 'seatbelt',
      reason: 'enforced',
    })
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

  test('fails closed when a confined mode has no usable platform backend', () => {
    expect(() =>
      buildSystemProcessConfinementSpawnSpec(
        {
          spec: { file: 'cmd.exe', args: ['/c', 'exit 0'] },
          policy: { mode: 'read-only', workspaceRoot: 'C:\\workspace' },
        },
        { platform: 'win32' }
      )
    ).toThrow('已拒绝以裸进程继续执行')

    expect(() =>
      buildSystemProcessConfinementSpawnSpec(
        {
          spec: { file: '/bin/sh', args: ['-lc', 'true'] },
          policy: { mode: 'read-only', workspaceRoot: '/workspace' },
        },
        { platform: 'linux', bubblewrapAvailable: false }
      )
    ).toThrow('已拒绝以裸进程继续执行')
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

  test('publishes only canonical system tool ids', () => {
    expect(Object.keys(systemTools).toSorted()).toEqual(Object.values(SystemToolNames).toSorted())
    expect(Object.keys(systemTools).every((name) => name.startsWith('system:'))).toBe(true)
  })

  test('does not publish project discovery or diagnostic shortcuts', () => {
    expect(Object.hasOwn(systemTools, 'discover_projects')).toBe(false)
    expect(Object.hasOwn(systemTools, 'diagnose_dev_runtime')).toBe(false)
    expect(Object.hasOwn(systemTools, 'get_system_overview')).toBe(false)
  })

  test('only reaps commands that launch a real shell background job', () => {
    expect(shouldReapForegroundProcessGroupAfterExit('printf one && printf two')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('false || printf fallback')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('printf value | wc -c')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('server &')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &; printf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &\nprintf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('nohup server &')).toBe(false)
  })

  test('whitelisted commands still lose read-only status when their arguments write', () => {
    expect(isSystemShellCommandReadOnly('find . -name "*.ts"')).toBe(true)
    expect(isSystemShellCommandReadOnly('sed -n 1,20p file.txt')).toBe(true)
    // 白名单是「无人值守自动放行」与「可并发执行」两道判定的底；这几种写盘形态必须掉出来。
    expect(isSystemShellCommandReadOnly('find . -name "*.tmp" -delete')).toBe(false)
    expect(isSystemShellCommandReadOnly('find . -type f -exec rm {} ;')).toBe(false)
    expect(isSystemShellCommandReadOnly('sed -i s/a/b/ file.txt')).toBe(false)
    expect(isSystemShellCommandReadOnly('sed --in-place=.bak s/a/b/ file.txt')).toBe(false)
  })

  test('finds git subcommands after global options and fails closed for unknown forms', () => {
    expect(isSystemShellCommandReadOnly('git -C repo status')).toBe(true)
    expect(isSystemShellCommandReadOnly('git -c core.fileMode=false log -1')).toBe(true)
    expect(isSystemShellCommandReadOnly('git --git-dir repo/.git status')).toBe(true)
    expect(isSystemShellCommandReadOnly('git --git-dir=repo/.git status')).toBe(true)
    expect(isSystemShellCommandReadOnly('git -C --output=repo status')).toBe(true)
    expect(isSystemShellCommandReadOnly('git -C repo checkout main')).toBe(false)
    expect(isSystemShellCommandReadOnly('git --git-dir=repo/.git clean -fd')).toBe(false)
    expect(isSystemShellCommandReadOnly('git branch -D obsolete')).toBe(false)
    expect(isSystemShellCommandReadOnly('git config --set core.fileMode false')).toBe(false)
    expect(isSystemShellCommandReadOnly('git diff --output=changes.patch')).toBe(false)
    expect(isSystemShellCommandReadOnly('git log --output history.txt')).toBe(false)
    expect(isSystemShellCommandReadOnly('git show --output=commit.txt HEAD')).toBe(false)
    expect(isSystemShellCommandReadOnly('git --future-option status')).toBe(false)
    expect(isSystemShellCommandReadOnly('git future-command')).toBe(false)
    expect(isSystemShellCommandReadOnly('git -C')).toBe(false)
    expect(isParallelCommandExecutionSafe({
      command: 'git -C repo checkout main',
      parallel: true,
    })).toBe(false)
  })

  // 删整个文件夹恢复不了，不论带不带 -f 都要确认；删单个文件是日常操作，不打扰用户。
  test('treats every recursive removal as dangerous and explains it deletes a whole folder', () => {
    for (const command of [
      'rm -r ./directory',
      'rm -R ./directory',
      'rm --recursive ./directory',
      'rm --rec ./directory',
      'rm -r -f ./victim',
      'rm -f -r ./victim',
      'rm --recursive --force ./victim',
      'rm -r --force ./victim',
      'RM -RF /',
      '/bin/RM -Rf /',
      'RM --RECURSIVE --FORCE /',
      'sudo rm -r /tmp/cache',
      'ls | xargs rm -r',
      'git rm -rf ./directory',
      'rm ./directory -Recurse',
    ]) {
      const plan = analyzeCommandExecution(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.shouldRequestConfirmation).toBe(true)
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }

    for (const command of [
      'rm ./file',
      'rm -f ./file',
      'rm -v src/f.ts',
      'rm docs/s.md',
      'rm ./file -Force',
      'git rm -r --cached ./directory',
      'git rm -r ./directory',
    ]) {
      expect(analyzeCommandExecution(command).isDangerous).toBe(false)
    }
  })

  test('treats Windows recursive removal forms as dangerous but single-file deletes as routine', () => {
    for (const command of [
      'Remove-Item -Recurse -Force build',
      'Remove-Item build -Recurse',
      'Remove-Item build -Recurse:$true',
      'ri build -r',
      'rd /s /q build',
      'RMDIR /S build',
      'rmdir/s/q build',
      'del /s /q *.tmp',
    ]) {
      const plan = analyzeCommandExecution(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }

    for (const command of [
      'Remove-Item .\\notes.txt',
      'Remove-Item .\\notes.txt -Force',
      'del /f /q notes.txt',
      'del docs/s.md',
      'rd build',
      'git branch --del -r origin/obsolete',
    ]) {
      expect(analyzeCommandExecution(command).isDangerous).toBe(false)
    }
    expect(analyzeCommandExecution('Remove-Item HKLM:\\Software\\Demo').isDangerous).toBe(true)
  })

  test('dangerous shell approval identifies the precise command and working directory', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const context = {
      abortSignal: new AbortController().signal,
      approval: {
        awaitConfirmation: async (
          _message: string,
          _signal?: AbortSignal,
          options?: Record<string, unknown>
        ) => {
          seen.push(options)
        },
      },
      system: {
        canStartBackgroundCommands: () => true,
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }),
      },
    } as never

    await systemTools[SystemToolNames.run].execute({ command: 'rm -rf /tmp/velaros-fixture' }, context)
    expect(seen[0]).toMatchObject({
      approvalRisk: 'high',
      riskScope: 'system-command:dangerous',
      operation: { label: 'rm -rf /tmp/velaros-fixture' },
    })

    await systemTools[SystemToolNames.run].execute({ command: 'npm run dev' }, context)
    // 长驻服务只是体验型确认：低风险、可按类记忆，语义不变。
    expect(seen[1]).toEqual({ approvalRisk: 'low' })
  })

  test('does not count a final line ending as an extra addressable line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\nline-2\n')

      const result = await executeAtomicRead({ path, startLine: 1, endLine: 99 })

      expect(result.content).toBe('line-1\nline-2\n')
      expect(result.totalLines).toBe(2)
      expect(result.endLine).toBe(2)
      await expect(
        executeAtomicRead({ path, startLine: 3, maxChars: 100 })
      ).rejects.toThrow('startLine (3) > endLine (2)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves intentional empty lines before the final line ending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-empty-lines-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\n\n')

      const result = await executeAtomicRead({ path, startLine: 1, endLine: 99 })

      expect(result.content).toBe('line-1\n\n')
      expect(result.totalLines).toBe(2)
      expect(result.endLine).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves original line endings while keeping line-address pagination exact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-line-endings-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\r\nline-2\r\nline-3')

      const first = await executeAtomicRead({ path, startLine: 1, endLine: 2 })
      const second = await executeAtomicRead({ path, startLine: 3, endLine: 3 })

      expect(first.content).toBe('line-1\r\nline-2\r\n')
      expect(first.totalLines).toBe(3)
      expect(first.hasMore).toBe(true)
      expect(first.nextStartLine).toBe(3)
      expect(second.content).toBe('line-3')
      expect(`${first.content}${second.content}`).toBe('line-1\r\nline-2\r\nline-3')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('copies a bounded source range without round-tripping text through the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-write-source-'))
    const sourcePath = join(root, 'source.txt')
    const targetPath = join(root, 'target.txt')
    try {
      await writeFile(sourcePath, 'one\r\n  two\r\n\r\nfour  \r\nfive\r\n')
      const source = { path: sourcePath, startLine: 2, endLine: 4 }
      const resolved = await resolveAtomicWriteContent({ path: targetPath, source })
      expect(resolved).toEqual({ content: '  two\r\n\r\nfour  \r\n', copiedFrom: source })

      await executeAtomicWrite(
        { path: targetPath, source },
        {
          abortSignal: new AbortController().signal,
          approval: {
            requestApproval: async () => ({ approved: true }),
          },
          system: {} as never,
        }
      )
      expect(await readFile(targetPath, 'utf8')).toBe('  two\r\n\r\nfour  \r\n')
      await expect(
        resolveAtomicWriteContent({ path: targetPath, content: 'x', source })
      ).rejects.toThrow('Exactly one of content or source')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects device files as text input and write-copy sources',
    async () => {
      await expect(executeAtomicRead({ path: '/dev/null' })).rejects.toThrow(
        'Path is not a regular text file'
      )
      await expect(
        resolveAtomicWriteContent({
          path: join(tmpdir(), 'velaros-system-device-copy.txt'),
          source: { path: '/dev/null', startLine: 1, endLine: 1 },
        })
      ).rejects.toThrow('Path is not a regular text file')
    }
  )
})
