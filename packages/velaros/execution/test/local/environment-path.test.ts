import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, spyOn, test } from 'bun:test'

import { createLocalShellHost } from '../../impl/local/LocalShellHost.js'
import type { ShellEnvironmentApi } from '../../impl/local/ShellEnvironment.js'
import { shellResolver } from '../../impl/local/ShellResolver.js'

/** 独立临时 shell 模拟启动配置；不改用户配置，不依赖某个项目或工具。 */
async function fixture(
  mode: 'replace' | 'empty' | 'fail' | 'malformed',
  shellName = 'fixture-shell',
  bannerNewline = true
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shell-path-inspection-')))
  const oldPath = join(root, 'before-start')
  const first = join(root, 'first')
  const second = join(root, 'second')
  const shell = join(root, shellName)
  const log = join(root, 'starts')
  for (const cwd of [oldPath, first, second]) await mkdir(cwd)
  for (const cwd of [first, second]) {
    const bin = join(cwd, 'tools with space')
    await mkdir(bin)
    const tool = join(bin, 'path-proof-tool')
    await writeFile(tool, '#!/bin/sh\nprintf proof\n')
    await chmod(tool, 0o700)
  }
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$1" >> '${log}'`,
    'if [ "$1" != -lc ]; then exit 31; fi',
    mode === 'empty' ? 'PATH=' : 'PATH="$PWD/tools with space"',
    'export PATH',
    mode === 'fail' || mode === 'malformed'
      ? `case "$2" in *VelarOS-shell-ready*) ;; *) printf incomplete; exit ${mode === 'fail' ? 17 : 0} ;; esac`
      : `printf 'startup banner${bannerNewline ? '\\n' : ''}'`,
    'exec /bin/sh -c "$2"',
    '',
  ].join('\n')
  await writeFile(shell, script)
  await chmod(shell, 0o700)
  const env = { PATH: oldPath, SHELL: shell, VELAROS_SHELL_PATH: shell }
  const environment: ShellEnvironmentApi = {
    getEnvironment: async () => ({ ...env }),
    getShellPath: () => shell,
    resolveShell: () => shellResolver.resolveReady({ env }),
    getRevision: () => 0,
    refresh: async () => ({ ...env }),
    subscribe: () => () => {},
    dispose: async () => {},
  }
  return { root, first, second, shell, log, env, environment }
}

/** 合成解释器只模拟 PATH 变量大小写、分隔符和输出边界；不冒充原生 Windows 执行。 */
async function syntaxFixture(kind: 'pwsh' | 'powershell' | 'cmd', path: string, complete = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shell-path-syntax-')))
  const shell = join(root, kind === 'cmd' ? 'cmd.exe' : kind)
  const source = [
    `#!${process.execPath}`,
    `const kind = ${JSON.stringify(kind)}`,
    `const path = ${JSON.stringify(path)}`,
    `const complete = ${JSON.stringify(complete)}`,
    'const args = process.argv.slice(2)',
    'const command = args.at(-1)',
    'const marker = command.match(/path-[a-f0-9-]+/)?.[0]',
    'if (!marker) process.exit(32)',
    "process.stdout.write('startup noise without newline')",
    "if (kind === 'cmd') {",
    "  if (JSON.stringify(args.slice(0, 4)) !== JSON.stringify(['/d', '/s', '/v:off', '/c'])) process.exit(33)",
    "  if (command.includes('echo.&echo ')) process.stdout.write('\\r\\n')",
    "  process.stdout.write(marker + '\\r\\n')",
    "  if (path) process.stdout.write('Path=' + path + '\\r\\n')",
    "  process.stdout.write('PATHEXT=.EXE;.CMD\\r\\n')",
    "  if (complete) process.stdout.write(marker + '-end\\r\\n')",
    '} else {',
    "  if (JSON.stringify(args.slice(0, 4)) !== JSON.stringify(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])) process.exit(34)",
    "  const value = command.includes('$env:PATH') ? process.env.PATH : process.env.Path || ''",
    "  process.stdout.write('\\0' + marker + '\\0PATH=' + value + (complete ? '\\0' : ''))",
    '}',
    '',
  ].join('\n')
  await writeFile(shell, source)
  await chmod(shell, 0o700)
  return { root, shell: shellResolver.resolve({ shellPath: shell, env: { PATH: path }, kind }) }
}

for (const kind of ['pwsh', 'powershell'] as const)
  test.skipIf(process.platform === 'win32')(
    `${kind} 在非 Windows 上读取大小写敏感的 PATH 并按冒号拆分`,
    async () => {
      const f = await syntaxFixture(kind, '/first tools:/second')
      try {
        expect(f.shell.kind).toBe(kind)
        await expect(shellResolver.inspectPath(f.shell, f.root)).resolves.toEqual([
          '/first tools',
          '/second',
        ])
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )

for (const path of ['C:\\first tools;D:\\second', ''])
  test.skipIf(process.platform === 'win32')(
    `CMD 合成输出隔离无换行欢迎文本及 PATHEXT，正确读取${path ? '非空' : '空'} PATH`,
    async () => {
      const f = await syntaxFixture('cmd', path)
      try {
        await expect(shellResolver.inspectPath(f.shell, f.root)).resolves.toEqual(
          path ? ['C:\\first tools', 'D:\\second'] : []
        )
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )

test.skipIf(process.platform === 'win32')('CMD 合成输出缺结束边界时明确报告未知 PATH', async () => {
  const f = await syntaxFixture('cmd', '', false)
  try {
    await expect(shellResolver.inspectPath(f.shell, f.root)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')('无换行欢迎文本不改变真实命令的可用性报告', async () => {
  const f = await fixture('replace', 'fixture-shell', false)
  const host = createLocalShellHost({ cwd: f.first, environment: f.environment })
  try {
    const inspected = await host.inspectEnvironment(['path-proof-tool'])
    const executed = await host.runCommand('path-proof-tool')
    expect(executed.exitCode).toBe(0)
    expect(executed.stdout).toContain('proof')
    expect(inspected.commands[0]).toMatchObject({
      available: true,
      path: join(f.first, 'tools with space', 'path-proof-tool'),
    })
  } finally {
    await host.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  '一项探测早拒绝时仍等待另一项探测结束后再抛错',
  async () => {
    const f = await fixture('replace')
    const ready = shellResolver.resolve({ env: f.env })
    f.environment.resolveShell = async () => ready
    const host = createLocalShellHost({ cwd: f.first, environment: f.environment })
    const path = spyOn(shellResolver, 'inspectPath').mockResolvedValue([])
    const failure = new Error('early probe failure')
    const late = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let lateFinished = false
    const command = spyOn(shellResolver, 'resolveCommand').mockImplementation(async (name) => {
      if (name === 'early') throw failure
      started.resolve()
      await late.promise
      lateFinished = true
      return { name, available: false, path: null, kind: null }
    })
    let returned = false
    const pending = host.inspectEnvironment(['early', 'late']).then(
      () => {
        returned = true
        return null
      },
      (error: unknown) => {
        returned = true
        return error
      }
    )
    try {
      await started.promise
      // 让早失败的微任务链有机会完成；晚探测仍由显式闸门阻塞。
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(lateFinished).toBe(false)
      expect(returned).toBe(false)
      late.resolve()
      expect(await pending).toBe(failure)
      expect(lateFinished).toBe(true)
    } finally {
      late.resolve()
      await pending
      path.mockRestore()
      command.mockRestore()
      await host.dispose()
      await rm(f.root, { recursive: true, force: true })
    }
  }
)

for (const shellName of ['fixture-shell', 'other-shell']) {
  test.skipIf(process.platform === 'win32')(
    `环境报告与 ${shellName} 启动后的 PATH、命令查找及工作目录一致`,
    async () => {
      const f = await fixture('replace', shellName)
      const initial = { ...f.env }
      try {
        for (const cwd of [f.first, f.second]) {
          const host = createLocalShellHost({ cwd, environment: f.environment })
          try {
            const inspected = await host.inspectEnvironment(['path-proof-tool'])
            expect(inspected.shell.pathEntries).toEqual([join(cwd, 'tools with space')])
            expect(inspected.commands).toEqual([
              {
                name: 'path-proof-tool',
                available: true,
                path: join(cwd, 'tools with space', 'path-proof-tool'),
                kind: 'script',
              },
            ])
            const executed = await host.runCommand('printf "path=%s\\n" "$PATH"; path-proof-tool')
            expect(executed.exitCode).toBe(0)
            expect(executed.stdout).toContain(`path=${inspected.shell.pathEntries[0]}\nproof`)
            expect(f.env).toEqual(initial)
          } finally {
            await host.dispose()
          }
        }
        // 每次检查：一次就绪、一次 PATH、一次命令查找；执行另有一次就绪和一次命令。
        expect((await readFile(f.log, 'utf8')).trim().split('\n')).toEqual(Array(10).fill('-lc'))
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )
}

test.skipIf(process.platform === 'win32')(
  '启动配置清空 PATH 时报告空数组，不恢复启动前值',
  async () => {
    const f = await fixture('empty')
    const host = createLocalShellHost({ cwd: f.first, environment: f.environment })
    try {
      const inspected = await host.inspectEnvironment(['path-proof-tool'])
      expect(inspected.shell.pathEntries).toEqual([])
      expect(inspected.commands[0]?.available).toBe(false)
      const executed = await host.runCommand('printf "path=<%s>" "$PATH"')
      expect(executed.stdout).toContain('path=<>')
    } finally {
      await host.dispose()
      await rm(f.root, { recursive: true, force: true })
    }
  }
)

for (const mode of ['fail', 'malformed'] as const)
  test.skipIf(process.platform === 'win32')(
    `${mode} 探测明确拒绝未知 PATH，不伪报启动前环境`,
    async () => {
      const f = await fixture(mode)
      const host = createLocalShellHost({ cwd: f.first, environment: f.environment })
      try {
        await expect(host.inspectEnvironment()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
        expect(f.env.PATH).toBe(join(f.root, 'before-start'))
      } finally {
        await host.dispose()
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )
