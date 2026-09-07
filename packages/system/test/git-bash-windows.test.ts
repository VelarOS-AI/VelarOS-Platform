import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { expect, test } from 'bun:test'

import { LocalSystemKernel } from '../src/kernel/LocalSystemKernel'
import { SystemPlatformCompatibility,SystemShellUnavailableError } from '../src/SystemPlatformCompatibility'
import { buildSystemOwnedProcessSpec } from '../src/SystemProcessHost'
import { buildSystemNativeCommandSpec, resolveSystemShell, resolveSystemShellReady } from '../src/SystemShell'

function hasGitBash(): boolean {
  if (process.platform !== 'win32') return false
  try { return resolveSystemShell().kind === 'git-bash' } catch { return false }
}

test.skipIf(!hasGitBash())(
  'runs Git Bash tools and native Node with a Unicode Windows cwd and literal arguments',
  async () => {
    const resolved = resolveSystemShell()
    expect(resolved.shellPath.toLowerCase()).toMatch(/\\bin\\bash\.exe$/)
    const cwd = mkdtempSync(join(tmpdir(), 'VelarOS Git Bash 中文 '))
    try {
      writeFileSync(join(cwd, '中文 空格.txt'), 'hello\n', 'utf8')
      const kernel = new LocalSystemKernel({ cwd })
      const tools = await kernel.runCommand(
        "command -v find && command -v grep && find . -name '*.txt' -print | grep '中文'",
        { timeoutMs: 8_000 }
      )
      expect(tools.success).toBe(true)
      const lines = tools.stdout.trim().split(/\r?\n/)
      expect(lines[0]).toMatch(/\/usr\/bin\/find(?:\.exe)?$/)
      expect(lines[1]).toMatch(/\/usr\/bin\/grep(?:\.exe)?$/)
      expect(lines[2]).toBe('./中文 空格.txt')

      const platform = new SystemPlatformCompatibility()
      const args = ['中文🙂 空格', `literal $HOME "double" 'single' \`text\` \\n`]
      const script = `
        process.stdout.write(JSON.stringify({
          platform: process.platform, cwd: process.cwd(), args: process.argv.slice(1)
        }));
        process.stderr.write('错误🙂');
        process.exitCode = 17;
      `
      const result = await kernel.runCommand(
        `node -e ${platform.quoteShellArg(script)} -- ${args.map((arg) => platform.quoteShellArg(arg)).join(' ')}`,
        { timeoutMs: 8_000 }
      )
      expect(result.exitCode).toBe(17)
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(false)
      expect(result.stderr).toBe('错误🙂')
      const output = JSON.parse(result.stdout) as { platform: string; cwd: string; args: string[] }
      expect(output.platform).toBe('win32')
      expect(win32.normalize(output.cwd).toLowerCase()).toBe(win32.normalize(cwd).toLowerCase())
      expect(output.args).toEqual(args)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  20_000
)

test.skipIf(process.platform !== 'win32')(
  'runs native argv and batch shims with literal metacharacters from every available Windows shell',
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'VelarOS argv 中文 '))
    try {
      const args = ['/container/path', '--value=/a:/b', '中文🙂 %PATH% !literal! "double" & value', 'C:\\trailing\\']
      const script = join(cwd, 'argv.cjs')
      writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("错误🙂");process.exitCode=17;', 'utf8')
      const shimDir = join(cwd, 'node_modules', '.bin')
      mkdirSync(shimDir, { recursive: true })
      const shim = join(shimDir, '中文 tool.cmd')
      writeFileSync(shim, '@echo off\r\nnode "%~dp0..\\..\\argv.cjs" %*\r\n', 'utf8')
      const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
      const selected = await resolveSystemShellReady()
      const candidates = [...new Set([
        selected.shellPath,
        join(windowsRoot, 'System32', 'cmd.exe'),
        join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      ])].filter(existsSync)
      const shells = await Promise.all(candidates.map((shellPath) => resolveSystemShellReady({ shellPath })))
      for (const shell of shells) {
        const platform = new SystemPlatformCompatibility()
        const shellSpec = platform.getShellCommandSpec(`node.exe ${platform.quoteShellArg(script, shell)}`, shell)
        const ownedShell = buildSystemOwnedProcessSpec(shellSpec, { env: shell.env })
        expect(ownedShell.ownership.backend).toBe('windows-job')
        const shellResult = spawnSync(ownedShell.spec.file, ownedShell.spec.args, {
          env: shell.env, cwd, encoding: 'utf8', windowsHide: true, timeout: 8_000,
          windowsVerbatimArguments: ownedShell.spec.windowsVerbatimArguments,
        })
        expect(shellResult.status).toBe(17)
        expect(shellResult.stderr).toBe('错误🙂')
        expect(JSON.parse(shellResult.stdout)).toEqual([])
        for (const input of [{ file: 'node.exe', args: [script, ...args] }, { file: shim, args }]) {
          const plan = buildSystemNativeCommandSpec(input, shell)
          const owned = buildSystemOwnedProcessSpec(plan, { env: plan.env })
          expect(owned.ownership.backend).toBe('windows-job')
          const result = spawnSync(owned.spec.file, owned.spec.args, {
            env: plan.env, cwd, encoding: 'utf8', windowsHide: true,
            windowsVerbatimArguments: owned.spec.windowsVerbatimArguments, timeout: 8_000,
          })
          expect(result.status).toBe(17)
          expect(result.stderr).toBe('错误🙂')
          expect(JSON.parse(result.stdout)).toEqual(args)
        }
      }
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  },
  25_000
)

test.skipIf(process.platform !== 'win32')(
  'reports an invalid explicit Git Bash installation before spawning a command',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'VelarOS missing Git 中文 '))
    try {
      const env = { ...process.env, VELAROS_SHELL_PATH: join(root, 'bin', 'bash.exe') }
      expect(() => resolveSystemShell({ env })).toThrow(SystemShellUnavailableError)
      expect(() => resolveSystemShell({ env })).toThrow('Install Git for Windows')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
