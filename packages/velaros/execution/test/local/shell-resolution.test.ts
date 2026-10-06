import { tmpdir } from 'node:os'
import { win32 } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createPlatform } from '@velaros-ai/core/platform'

import { createLocalShellHost } from '../../impl/local/LocalShellHost.js'
import { shellResolver } from '../../impl/local/ShellResolver.js'
import { ShellUnavailableError } from '../../impl/local/ShellUnavailableError.js'
import {
  describeUnavailableShellKind,
  detectAvailableShells,
  toShellDescriptor,
} from '../../utils/shells.js'
import { parseOpenPortEntries, parseProcessRows } from '../../utils/system-info.js'

describe('platform command output parsing', () => {
  test('parses the native Windows netstat listener format', () => {
    expect(
      parseOpenPortEntries(
        [
          '  Proto  Local Address          Foreign Address        State           PID',
          '  TCP    0.0.0.0:3306           0.0.0.0:0              LISTENING       6928',
          '  TCP    [::]:135               [::]:0                 LISTENING       1892',
          '  TCP    127.0.0.1:5000         127.0.0.1:5001         ESTABLISHED     42',
        ].join('\r\n'),
        'win32'
      )
    ).toEqual([
      { pid: 6928, processName: null, address: '0.0.0.0', port: 3306, state: 'LISTENING' },
      { pid: 1892, processName: null, address: '::', port: 135, state: 'LISTENING' },
    ])
  })

  test('parses the native Windows tasklist process format', () => {
    expect(
      parseProcessRows(
        [
          '"System","4","Services","0","1,024 K"',
          '"worker, helper.exe","2048","Console","1","12,345 K"',
        ].join('\r\n'),
        'win32'
      )
    ).toEqual([
      expect.objectContaining({ pid: 4, ppid: 0, name: 'System', memoryBytes: 1024 * 1024 }),
      expect.objectContaining({
        pid: 2048,
        ppid: 0,
        name: 'worker, helper.exe',
        memoryBytes: 12_345 * 1024,
      }),
    ])
  })
})

describe('Windows Git Bash resolution', () => {
  function filesystem(...roots: string[]): {
    isFile: (path: string) => boolean
    files: Set<string>
  } {
    const key = (path: string) => win32.normalize(path).toLowerCase()
    const files = new Set(
      roots.flatMap((root) =>
        [
          'bin\\bash.exe',
          'usr\\bin\\bash.exe',
          'usr\\bin\\msys-2.0.dll',
          'git-bash.exe',
          'cmd\\git.exe',
          'mingw64\\bin\\git.exe',
        ].map((file) => key(win32.join(root, file)))
      )
    )
    return { files, isFile: (path) => files.has(key(path)) }
  }

  test.each([
    [{ ProgramFiles: 'D:\\Applications' }, 'D:\\Applications\\Git'],
    [{ 'ProgramFiles(x86)': 'D:\\Applications (x86)' }, 'D:\\Applications (x86)\\Git'],
    [{ ProgramW6432: 'E:\\Applications' }, 'E:\\Applications\\Git'],
    [
      { LOCALAPPDATA: 'C:\\Users\\中文 用户\\AppData\\Local' },
      'C:\\Users\\中文 用户\\AppData\\Local\\Programs\\Git',
    ],
    [
      { LOCALAPPDATA: 'C:\\Users\\中文 用户\\AppData\\Local' },
      'C:\\Users\\中文 用户\\AppData\\Local\\Git',
    ],
  ] as const)('discovers a Git for Windows installation using %j', (env, root) => {
    const { isFile } = filesystem(root)
    const resolved = shellResolver.resolve({ platform: 'win32', env, isFile })
    expect(resolved.shellPath).toBe(win32.join(root, 'bin', 'bash.exe'))
  })

  test('discovers custom Git installs through git.exe on PATH and preserves paths with spaces', () => {
    const root = 'E:\\Development Tools\\PortableGit'
    const { isFile } = filesystem(root)
    const env = {
      Path: `C:\\Windows\\System32;"${root}\\cmd";E:\\Node`,
      LANG: 'zh_CN.GBK',
      lc_all: 'C',
      BASH_ENV: 'C:\\custom-startup.sh',
      ENV: 'C:\\custom-startup.sh',
      KEEP_THIS: '中文',
    }
    const resolved = shellResolver.resolve({ platform: 'win32', env, isFile })
    expect(resolved.shellPath).toBe(`${root}\\bin\\bash.exe`)
    expect(resolved.env.PATH?.split(';')).toEqual([
      `${root}\\usr\\bin`,
      `${root}\\mingw64\\bin`,
      `${root}\\bin`,
      `${root}\\cmd`,
      'C:\\Windows\\System32',
      'E:\\Node',
    ])
    expect(resolved.env.Path).toBeUndefined()
    expect(resolved.env.LANG).toBe('en_US.UTF-8')
    expect(resolved.env.LC_ALL).toBe('en_US.UTF-8')
    expect(resolved.env.lc_all).toBeUndefined()
    expect(resolved.env.PYTHONIOENCODING).toBe('utf-8')
    expect(resolved.env.BASH_ENV).toBeUndefined()
    expect(resolved.env.ENV).toBeUndefined()
    expect(resolved.env.KEEP_THIS).toBe('中文')
    expect(env.Path).toBe(`C:\\Windows\\System32;"${root}\\cmd";E:\\Node`)
    expect(createPlatform({ platform: 'win32', env: resolved.env }).getPreferredShellPath()).toBe(
      resolved.shellPath
    )
  })

  test('accepts an explicit Git Bash executable and diagnoses an unavailable pinned selection', () => {
    const root = 'D:\\Tools\\PortableGit'
    const { isFile } = filesystem(root, 'C:\\Program Files\\Git')
    expect(
      shellResolver.resolve({
        platform: 'win32',
        env: { VELAROS_GIT_BASH: `${root}\\usr\\bin\\bash.exe` },
        isFile,
      }).shellPath
    ).toBe(`${root}\\usr\\bin\\bash.exe`)
    for (const shellPath of [
      'bash.exe',
      '.\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\bash.exe',
      `${root}\\bin\\sh.exe`,
    ]) {
      expect(() =>
        shellResolver.resolve({
          platform: 'win32',
          env: { VELAROS_SHELL_PATH: shellPath },
          isFile,
        })
      ).toThrow(ShellUnavailableError)
    }
  })

  test('ignores WSL Bash on PATH and rejects incomplete Git installations', () => {
    const root = 'C:\\Program Files\\Git'
    const { files, isFile } = filesystem(root)
    files.add('c:\\windows\\system32\\bash.exe')
    expect(
      shellResolver.resolve({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, isFile })
        .shellPath
    ).toBe(`${root}\\bin\\bash.exe`)
    files.delete('c:\\program files\\git\\usr\\bin\\msys-2.0.dll')
    expect(() =>
      shellResolver.resolve({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, isFile })
    ).toThrow('安装 Git for Windows')
  })

  test('missing Git can be installed and retried without restarting the process', () => {
    const { files, isFile } = filesystem()
    const options = { platform: 'win32' as const, env: {}, isFile }
    expect(() => shellResolver.resolve(options)).toThrow('找不到能用的命令 shell')
    for (const file of filesystem('C:\\Program Files\\Git').files) files.add(file)
    expect(shellResolver.resolve(options).shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    files.clear()
    expect(() => shellResolver.resolve(options)).toThrow(ShellUnavailableError)
  })

  test('keeps POSIX shell selection and environment unchanged', () => {
    const env = { SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', PATH: '/usr/bin:/bin' }
    expect(shellResolver.resolve({ platform: 'darwin', env })).toMatchObject({
      shellPath: '/bin/zsh',
      env,
    })
    expect(shellResolver.resolve({ platform: 'linux', env, shellPath: '/bin/bash' })).toMatchObject(
      { shellPath: '/bin/bash', env }
    )
  })
})

describe('挑哪个 shell', () => {
  const windowsFilesystem = (root: string): ((path: string) => boolean) => {
    const key = (path: string): string => win32.normalize(path).toLowerCase()
    const files = new Set([
      ...[
        'bin\\bash.exe',
        'usr\\bin\\bash.exe',
        'usr\\bin\\msys-2.0.dll',
        'git-bash.exe',
        'cmd\\git.exe',
      ].map((file) => key(win32.join(root, file))),
      key('C:\\Windows\\System32\\cmd.exe'),
      key('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ])
    return (path) => files.has(key(path))
  }

  test('POSIX 机器上清单只有 posix 一项，挑别的就是一个候选都没有', () => {
    const options = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' } }
    expect(detectAvailableShells(options).map((shell) => shell.kind)).toEqual(['posix'])
    expect(detectAvailableShells({ ...options, kind: 'posix' })).toHaveLength(1)
    expect(detectAvailableShells({ ...options, kind: 'pwsh' })).toEqual([])
  })

  test('Windows 上按优先顺序给出清单，挑定一种就只留那一种', () => {
    const options = {
      platform: 'win32' as const,
      env: { PATH: '' },
      isFile: windowsFilesystem('C:\\Program Files\\Git'),
    }
    expect(detectAvailableShells(options).map((shell) => shell.kind)).toEqual([
      'git-bash',
      'powershell',
      'cmd',
    ])
    expect(detectAvailableShells({ ...options, kind: 'cmd' }).map((shell) => shell.kind)).toEqual([
      'cmd',
    ])
    expect(detectAvailableShells({ ...options, kind: 'pwsh' })).toEqual([])
  })

  test('挑了本机没有的那个，报错点名可用的有哪些、哪个是默认，并给下一步', () => {
    const candidates = detectAvailableShells({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
    }).map(toShellDescriptor)
    const message = describeUnavailableShellKind('pwsh', candidates)
    expect(message).toContain('本机没有 pwsh')
    expect(message).toContain('可用：posix（默认）')
    expect(message).toContain('不填 shell')
    expect(describeUnavailableShellKind('cmd', [])).toContain('一个可用的 shell 都没找到')
  })

  test('挑了本机没有的那个，命令在起进程之前就被拒', async () => {
    const kernel = createLocalShellHost({ cwd: tmpdir() })
    try {
      await expect(kernel.runCommand('echo 不该跑起来', { shell: 'pwsh' })).rejects.toThrow(
        '本机没有 pwsh'
      )
      expect((await kernel.runCommand('echo ok', { shell: 'posix' })).stdout.trim()).toBe('ok')
    } finally {
      await kernel.dispose()
    }
  })

  test('环境检查报出可用清单，第一项就是默认那个', async () => {
    const kernel = createLocalShellHost({ cwd: tmpdir() })
    try {
      const inspection = await kernel.inspectEnvironment()
      expect(inspection.shells.map((shell) => shell.kind)).toEqual(['posix'])
      expect(inspection.shells[0]?.kind).toBe(inspection.shell.kind!)
    } finally {
      await kernel.dispose()
    }
  })
})
