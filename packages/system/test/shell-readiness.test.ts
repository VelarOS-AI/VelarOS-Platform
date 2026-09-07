import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { SystemPlatformCompatibility, SystemShellUnavailableError } from '../src/SystemPlatformCompatibility'
import {
  buildSystemNativeCommandSpec, describeSystemNativeCommand, refreshWindowsEnvironment,
  resolveSystemCommand, resolveSystemShell, resolveSystemShellReady,
} from '../src/SystemShell'

const gitRoot = 'C:\\Program Files\\Git'
const bash = `${gitRoot}\\bin\\bash.exe`
const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const cmd = 'C:\\Windows\\System32\\cmd.exe'

function installed(...shells: string[]) {
  const files = new Set(shells.map((file) => win32.normalize(file).toLowerCase()))
  if (shells.includes(bash)) for (const file of ['git-bash.exe', 'usr\\bin\\msys-2.0.dll', 'cmd\\git.exe']) {
    files.add(win32.join(gitRoot, file).toLowerCase())
  }
  return (file: string) => files.has(win32.normalize(file).toLowerCase())
}

describe('Windows shell readiness and fallback', () => {
  test.each([
    [[bash, pwsh, powershell, cmd], 'git-bash'],
    [[pwsh, powershell, cmd], 'pwsh'],
    [[powershell, cmd], 'powershell'],
    [[cmd], 'cmd'],
  ] as const)('selects the first installed shell from %j', (paths, kind) => {
    const shell = resolveSystemShell({ platform: 'win32', env: {}, isFile: installed(...paths) })
    expect(shell.kind).toBe(kind)
    expect(shell.env.VELAROS_SHELL_KIND).toBe(kind)
    expect(shell.env.VELAROS_SHELL_PATH).toBe(shell.shellPath)
    expect(shell.recommendation?.code ?? null).toBe(kind === 'git-bash' ? null : 'INSTALL_GIT_BASH')
  })

  test('falls through failed preflight probes and pins the successful shell for command generation', async () => {
    const checked: string[] = []
    const options = { platform: 'win32' as const, env: {}, isFile: installed(bash, pwsh, powershell, cmd) }
    const shell = await resolveSystemShellReady({
      ...options,
      probe: async (candidate) => {
        checked.push(candidate.kind)
        return { ready: candidate.kind === 'powershell', version: '5.1', reason: 'startup failed' }
      },
    })
    expect(checked).toEqual(['git-bash', 'pwsh', 'powershell'])
    expect(shell.readiness).toBe('ready')
    expect(shell.version).toBe('5.1')
    expect(resolveSystemShell({ ...options, env: shell.env }).shellPath).toBe(powershell)
    expect(new SystemPlatformCompatibility({ platform: 'win32' }).getShellCommandSpec('Write-Output ready', shell).file)
      .toBe(powershell)
  })

  test('an invalid Git override still permits available Windows shells; unavailable pinned selection asks to refresh', () => {
    const isFile = installed(cmd)
    expect(resolveSystemShell({ platform: 'win32', env: { VELAROS_GIT_BASH: 'C:\\bad\\bash.exe' }, isFile }).kind)
      .toBe('cmd')
    expect(() => resolveSystemShell({ platform: 'win32', env: { VELAROS_SHELL_PATH: bash }, isFile }))
      .toThrow(SystemShellUnavailableError)
  })

  test('all failed preflights produce an actionable result without running a user command', async () => {
    await expect(resolveSystemShellReady({
      platform: 'win32', env: {}, isFile: installed(cmd),
      probe: async () => ({ ready: false, reason: 'blocked executable' }),
    })).rejects.toThrow('Install Git for Windows')
  })

  test('PowerShell and CMD specs initialize encoding and retain their own command syntax', () => {
    const platform = new SystemPlatformCompatibility({ platform: 'win32' })
    const ps = platform.getShellCommandSpec("Write-Output '中文'; node -e 'process.exit(17)'", { shellPath: powershell })
    expect(ps.args.at(-1)).toContain('[Console]::OutputEncoding')
    expect(ps.args.at(-1)).toContain('exit $LASTEXITCODE')
    expect(platform.quoteShellArg("O'Brien $env:PATH", { kind: 'powershell' })).toBe("'O''Brien $env:PATH'")
    expect(platform.getShellCommandSpec('echo %TEMP%', { shellPath: cmd })).toEqual({
      file: cmd, args: ['/d', '/s', '/v:off', '/c', '"chcp 65001 >nul & echo %TEMP%"'],
      windowsVerbatimArguments: true,
    })
    const quotedCommand = '"C:\\工具 目录\\node.exe" "C:\\中文 项目\\argv.cjs" "中文 空格"'
    const quotedSpec = platform.getShellCommandSpec(quotedCommand, { shellPath: cmd })
    expect(quotedSpec.args.at(-1)).toBe(`"chcp 65001 >nul & ${quotedCommand}"`)
    expect(quotedSpec.windowsVerbatimArguments).toBe(true)
    expect(() => platform.quoteShellArg('%PATH%', { kind: 'cmd' })).toThrow('native file + argv')
  })

  test('native argv and environment overrides retain literal values without MSYS conversion', () => {
    const shell = resolveSystemShell({ platform: 'win32', env: { PATH: 'C:\\original' }, isFile: installed(bash) })
    const args = ['/container/path', '--value=/a:/b', '中文🙂 "double" %PATH% ! &', 'C:\\trailing\\']
    const plan = buildSystemNativeCommandSpec({ file: 'C:\\Tools\\node.exe', args, env: { Path: 'C:\\override' } }, shell)
    expect(plan.file).toBe('C:\\Tools\\node.exe')
    expect(plan.args).toEqual(args)
    expect(plan.env.Path).toBe('C:\\override')
    expect(plan.env.PATH).toBeUndefined()
    expect(plan.windowsVerbatimArguments).toBeUndefined()
    const batch = buildSystemNativeCommandSpec({ file: 'C:\\Tools\\npm.cmd', args: ['--version'] }, shell)
    expect(batch.file).toBe(cmd)
    expect(batch.windowsVerbatimArguments).toBe(true)
    expect(describeSystemNativeCommand({ file: plan.file, args })).toContain('"/container/path"')
  })

  test('CMD builtin availability uses the selected shell', async () => {
    const shell = resolveSystemShell({ platform: 'win32', env: {}, isFile: installed(cmd) })
    expect(await resolveSystemCommand('dir', shell)).toMatchObject({ available: true, kind: 'builtin', path: 'dir' })
  })

  test.skipIf(process.platform === 'win32')('POSIX readiness and native execution preserve exact argv and exit code', async () => {
    const shell = await resolveSystemShellReady({ platform: 'linux', env: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' } })
    const args = ['/container/path', '中文🙂 %PATH% "quotes"']
    const plan = buildSystemNativeCommandSpec({
      file: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=7', ...args],
    }, shell)
    const result = spawnSync(plan.file, plan.args, { env: plan.env, encoding: 'utf8' })
    expect(result.status).toBe(7)
    expect(JSON.parse(result.stdout)).toEqual(args)
    const refreshed = await refreshWindowsEnvironment(shell.env, 'linux')
    expect(refreshed.env.VELAROS_SHELL_PATH).toBeUndefined()
    expect(refreshed.revision).toHaveLength(16)
  })
})
