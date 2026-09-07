import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from 'bun:test'

import { SystemPlatformCompatibility } from '../src/SystemPlatformCompatibility'
import { buildSystemOwnedProcessSpec, getSystemProcessHostPath } from '../src/SystemProcessHost'
import { buildSystemNativeCommandSpec, resolveSystemShellReady } from '../src/SystemShell'

test('process ownership fallback reports its actual cleanup capability', () => {
  const spec = { file: 'tool.exe', args: ['中文', '/foo'] }
  const result = buildSystemOwnedProcessSpec(spec, { platform: 'linux' })
  expect(result.spec).toEqual(spec)
  expect(result.ownership.parentDeathCleanup).toBe(false)
})

test('Windows without a native host reports bounded process-tree capability', () => {
  const spec = { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'echo available'] }
  const result = buildSystemOwnedProcessSpec(spec, { platform: 'win32', isFile: () => false })
  expect(result.spec).toEqual(spec)
  expect(result.ownership).toEqual({
    backend: 'process-tree', parentDeathCleanup: false, reason: 'native-host-unavailable',
  })
})

const windowsTest = test.skipIf(process.platform !== 'win32')

windowsTest('native host preserves Windows argv and exact exit status', async () => {
  const host = getSystemProcessHostPath()
  expect(host).not.toBeNull()
  const args = ['中文🙂 空格', 'a"b', 'trailing\\', '/foo:/bar', '%PATH%', '!x!', '']
  const result = await promisify(execFile)(host!, [
    '--parent-pid', String(process.pid), '--', process.execPath,
    '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args,
  ], { encoding: 'utf8', timeout: 8_000, windowsHide: true })
  expect(JSON.parse(result.stdout)).toEqual(args)
  const byName = await promisify(execFile)(host!, [
    '--parent-pid', String(process.pid), '--', basename(process.execPath),
    '-e', 'process.stdout.write("resolved-from-path")',
  ], { encoding: 'utf8', timeout: 8_000, windowsHide: true,
    env: { ...process.env, PATH: `${dirname(process.execPath)};${process.env.PATH ?? ''}` } })
  expect(byName.stdout).toBe('resolved-from-path')
  try {
    await promisify(execFile)(host!, ['--parent-pid', String(process.pid), '--', process.execPath,
      '-e', 'process.exit(17)'], { timeout: 8_000, windowsHide: true })
    throw new Error('Expected exit 17')
  } catch (error) {
    expect((error as { code?: number }).code).toBe(17)
  }
})

windowsTest('native host preserves CMD Unicode output and batch shim literal argv', async () => {
  const host = getSystemProcessHostPath()
  expect(host).not.toBeNull()
  const cwd = await mkdtemp(join(tmpdir(), 'velaros-cmd-中文 '))
  try {
    const shell = await resolveSystemShellReady({
      shellPath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      env: { ...process.env, VELAROS_PROCESS_HOST: host! },
    })
    expect(shell.kind).toBe('cmd')
    expect(shell.readiness).toBe('ready')
    const compatibility = new SystemPlatformCompatibility()
    const cmd = compatibility.getShellCommandSpec(
      'echo 中文🙂 标准输出& echo 错误🙂 1>&2& exit /b 17', shell
    )
    const shimDirectory = join(cwd, 'node_modules', '.bin')
    await mkdir(shimDirectory, { recursive: true })
    const shim = join(shimDirectory, '中文 tool.cmd')
    const args = ['中文🙂 空格', 'quote"slash\\', '/container/path', '%PATH%', '!literal!', 'a^&b|c<d>', '']
    await writeFile(join(cwd, 'argv.cjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("错误🙂");process.exitCode=17;', 'utf8')
    await writeFile(shim, '@echo off\r\n"%VELAROS_TEST_RUNTIME%" "%~dp0..\\..\\argv.cjs" %*\r\n', 'utf8')
    const quotedArgs = ['中文 空格', 'embedded "quote"']
    const quotedCmd = {
      ...compatibility.getShellCommandSpec(
        `"${process.execPath}" "${join(cwd, 'argv.cjs')}" ${quotedArgs.map((arg) => JSON.stringify(arg)).join(' ')}`,
        shell
      ),
      env: shell.env,
    }
    expect(quotedCmd.windowsVerbatimArguments).toBe(true)
    const batch = buildSystemNativeCommandSpec({
      file: shim, args, env: { VELAROS_TEST_RUNTIME: process.execPath },
    }, shell)
    expect(batch.windowsVerbatimArguments).toBe(true)
    for (const plan of [{ ...cmd, env: shell.env }, quotedCmd, batch]) {
      const owned = buildSystemOwnedProcessSpec(plan, { hostPath: host!, env: plan.env })
      expect(owned.ownership.backend).toBe('windows-job')
      expect(owned.spec.windowsVerbatimArguments).toBeUndefined()
      try {
        await promisify(execFile)(owned.spec.file, owned.spec.args, {
          cwd, env: plan.env, encoding: 'utf8', timeout: 8_000, windowsHide: true,
          windowsVerbatimArguments: owned.spec.windowsVerbatimArguments,
        })
        throw new Error('Expected exit 17')
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string }
        expect(result.code).toBe(17)
        expect(result.stderr?.trim()).toBe('错误🙂')
        if (plan === batch) expect(JSON.parse(result.stdout!)).toEqual(args)
        else if (plan === quotedCmd) expect(JSON.parse(result.stdout!)).toEqual(quotedArgs)
        else expect(result.stdout?.trim()).toBe('中文🙂 标准输出')
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 25_000)

windowsTest('parent termination closes its native Job and reaps the child', async () => {
  const host = getSystemProcessHostPath()
  expect(host).not.toBeNull()
  const directory = await mkdtemp(join(tmpdir(), 'velaros-job-中文 '))
  const marker = join(directory, 'pid.txt')
  const script = join(directory, 'parent.cjs')
  await writeFile(script, `
    const {spawn}=require('node:child_process');
    spawn(${JSON.stringify(host)}, ['--parent-pid', String(process.pid), '--', process.execPath,
      '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`)}],
      {stdio:'ignore',windowsHide:true});
    setInterval(()=>{},1000);
  `)
  const parent = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true })
  let childPid = 0
  try {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !childPid) {
      childPid = Number(await readFile(marker, 'utf8').catch(() => '0'))
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(childPid).toBeGreaterThan(0)
    parent.kill('SIGKILL')
    let alive = true
    const cleanupDeadline = Date.now() + 5_000
    while (Date.now() < cleanupDeadline && alive) {
      try { process.kill(childPid, 0) } catch { alive = false }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(alive).toBe(false)
  } finally {
    parent.kill('SIGKILL')
    if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* Already reaped. */ } }
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)
