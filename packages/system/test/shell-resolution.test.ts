import { win32 } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createPlatform } from '@velaros-ai/platform'

import { systemShellResolver } from '../src/impl/SystemShellResolver.js'
import { SystemShellUnavailableError } from '../src/impl/SystemShellUnavailableError'
import { parseOpenPortEntries, parseProcessRows } from '../src/utils/system-info.js'

describe('platform command output parsing', () => {
  test('parses the native Windows netstat listener format', () => {
    expect(parseOpenPortEntries([
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3306           0.0.0.0:0              LISTENING       6928',
      '  TCP    [::]:135               [::]:0                 LISTENING       1892',
      '  TCP    127.0.0.1:5000         127.0.0.1:5001         ESTABLISHED     42',
    ].join('\r\n'), 'win32')).toEqual([
      { pid: 6928, processName: null, address: '0.0.0.0', port: 3306, state: 'LISTENING' },
      { pid: 1892, processName: null, address: '::', port: 135, state: 'LISTENING' },
    ])
  })

  test('parses the native Windows tasklist process format', () => {
    expect(parseProcessRows([
      '"System","4","Services","0","1,024 K"',
      '"worker, helper.exe","2048","Console","1","12,345 K"',
    ].join('\r\n'), 'win32')).toEqual([
      expect.objectContaining({ pid: 4, ppid: 0, name: 'System', memoryBytes: 1024 * 1024 }),
      expect.objectContaining({ pid: 2048, ppid: 0, name: 'worker, helper.exe', memoryBytes: 12_345 * 1024 }),
    ])
  })

})

describe('Windows Git Bash resolution', () => {
  function filesystem(...roots: string[]): { isFile: (path: string) => boolean; files: Set<string> } {
    const key = (path: string) => win32.normalize(path).toLowerCase()
    const files = new Set(roots.flatMap((root) => [
      'bin\\bash.exe', 'usr\\bin\\bash.exe', 'usr\\bin\\msys-2.0.dll',
      'git-bash.exe', 'cmd\\git.exe', 'mingw64\\bin\\git.exe',
    ].map((file) => key(win32.join(root, file)))))
    return { files, isFile: (path) => files.has(key(path)) }
  }

  test.each([
    [{ ProgramFiles: 'D:\\Applications' }, 'D:\\Applications\\Git'],
    [{ 'ProgramFiles(x86)': 'D:\\Applications (x86)' }, 'D:\\Applications (x86)\\Git'],
    [{ ProgramW6432: 'E:\\Applications' }, 'E:\\Applications\\Git'],
    [{ LOCALAPPDATA: 'C:\\Users\\中文 用户\\AppData\\Local' }, 'C:\\Users\\中文 用户\\AppData\\Local\\Programs\\Git'],
    [{ LOCALAPPDATA: 'C:\\Users\\中文 用户\\AppData\\Local' }, 'C:\\Users\\中文 用户\\AppData\\Local\\Git'],
  ] as const)('discovers a Git for Windows installation using %j', (env, root) => {
    const { isFile } = filesystem(root)
    const resolved = systemShellResolver.resolve({ platform: 'win32', env, isFile })
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
    const resolved = systemShellResolver.resolve({ platform: 'win32', env, isFile })
    expect(resolved.shellPath).toBe(`${root}\\bin\\bash.exe`)
    expect(resolved.env.PATH?.split(';')).toEqual([
      `${root}\\usr\\bin`, `${root}\\mingw64\\bin`, `${root}\\bin`, `${root}\\cmd`,
      'C:\\Windows\\System32', 'E:\\Node',
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
    expect(createPlatform({ platform: 'win32', env: resolved.env })
      .getPreferredShellPath()).toBe(resolved.shellPath)
  })

  test('accepts an explicit Git Bash executable and diagnoses an unavailable pinned selection', () => {
    const root = 'D:\\Tools\\PortableGit'
    const { isFile } = filesystem(root, 'C:\\Program Files\\Git')
    expect(systemShellResolver.resolve({
      platform: 'win32', env: { VELAROS_GIT_BASH: `${root}\\usr\\bin\\bash.exe` }, isFile,
    }).shellPath).toBe(`${root}\\usr\\bin\\bash.exe`)
    for (const shellPath of ['bash.exe', '.\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe', `${root}\\bin\\sh.exe`]) {
      expect(() => systemShellResolver.resolve({
        platform: 'win32', env: { VELAROS_SHELL_PATH: shellPath }, isFile,
      })).toThrow(SystemShellUnavailableError)
    }
  })

  test('ignores WSL Bash on PATH and rejects incomplete Git installations', () => {
    const root = 'C:\\Program Files\\Git'
    const { files, isFile } = filesystem(root)
    files.add('c:\\windows\\system32\\bash.exe')
    expect(systemShellResolver.resolve({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, isFile })
      .shellPath).toBe(`${root}\\bin\\bash.exe`)
    files.delete('c:\\program files\\git\\usr\\bin\\msys-2.0.dll')
    expect(() => systemShellResolver.resolve({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, isFile }))
      .toThrow('Install Git for Windows')
  })

  test('missing Git can be installed and retried without restarting the process', () => {
    const { files, isFile } = filesystem()
    const options = { platform: 'win32' as const, env: {}, isFile }
    expect(() => systemShellResolver.resolve(options)).toThrow('No working command shell')
    for (const file of filesystem('C:\\Program Files\\Git').files) files.add(file)
    expect(systemShellResolver.resolve(options).shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    files.clear()
    expect(() => systemShellResolver.resolve(options)).toThrow(SystemShellUnavailableError)
  })

  test('keeps POSIX shell selection and environment unchanged', () => {
    const env = { SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', PATH: '/usr/bin:/bin' }
    expect(systemShellResolver.resolve({ platform: 'darwin', env })).toMatchObject({ shellPath: '/bin/zsh', env })
    expect(systemShellResolver.resolve({ platform: 'linux', env, shellPath: '/bin/bash' }))
      .toMatchObject({ shellPath: '/bin/bash', env })
  })
})
