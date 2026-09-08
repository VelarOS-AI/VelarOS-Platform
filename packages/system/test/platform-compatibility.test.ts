import { win32 } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { SystemPlatformCompatibility,SystemShellUnavailableError } from '../src/SystemPlatformCompatibility'
import { parseOpenPortEntries } from '../src/SystemProcessParsers'
import { resolveSystemShell } from '../src/SystemShell'

describe('SystemPlatformCompatibility', () => {
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

  test('owns portable path primitives for product hosts', () => {
    const windows = new SystemPlatformCompatibility({ platform: 'win32' })

    expect(windows.getPlatform()).toBe('win32')
    expect(windows.isWindows()).toBe(true)
    expect(windows.isMacOS()).toBe(false)
    expect(windows.isAbsolutePathText('C:\\Users\\velaros')).toBe(true)
    expect(windows.isAbsolutePathText('\\\\server\\share')).toBe(true)
    expect(windows.isPathLikeCommand('.\\bin\\tool.exe')).toBe(true)
    expect(windows.toPortablePathText('C:\\Users\\velaros')).toBe('C:/Users/velaros')
    expect(windows.normalizePathTextForComparison(' C:\\Users\\velaros\\ ')).toBe(
      'C:/Users/velaros'
    )
    expect(windows.splitPathTextSegments('C:\\Users\\velaros')).toEqual(['C:', 'Users', 'velaros'])
    expect(windows.getPathTextBaseName('C:\\Users\\velaros\\')).toBe('velaros')
    expect(windows.joinPathText('C:\\Users', '\\velaros\\', 'project')).toBe(
      'C:\\Users\\velaros\\project'
    )
  })

  test('owns shell and executable selection across platforms', () => {
    const windows = new SystemPlatformCompatibility({
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATH: 'C:\\bin;D:\\tools',
        PATHEXT: '.EXE;.CMD',
        VELAROS_GIT_BASH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    })
    const macOS = new SystemPlatformCompatibility({
      platform: 'darwin',
      env: {
        SHELL: '/opt/homebrew/bin/zsh',
        PATH: '/opt/homebrew/bin:/usr/bin',
      },
    })

    expect(windows.getPathEntries()).toEqual(['C:\\bin', 'D:\\tools'])
    expect(windows.buildExecutableCandidates('velaros')).toEqual([
      'velaros',
      'velaros.EXE',
      'velaros.CMD',
    ])
    expect(windows.getShellCommandSpec('echo ready')).toEqual({
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--noprofile', '--norc', '-c', 'echo ready'],
    })
    expect(new SystemPlatformCompatibility({
      platform: 'win32',
      env: { ComSpec: 'C:\\Users\\attacker\\cmd.exe' },
    }).getOpenExternalFallbackSpec('https://example.com')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'start', '', 'https://example.com'],
    })
    expect(new SystemPlatformCompatibility({
      platform: 'win32',
      env: {
        ComSpec: 'cmd.exe',
        COMSPEC: 'powershell.exe',
        SystemRoot: 'D:\\CustomWindows',
      },
    }).getShellCommandSpec('echo ready').args).toEqual(['/d', '/s', '/v:off', '/c', '"chcp 65001 >nul & echo ready"'])
    expect(new SystemPlatformCompatibility({
      platform: 'win32',
      env: { ComSpec: '.\\cmd.exe', WINDIR: 'relative-root' },
    }).getPreferredShellPath()).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(new SystemPlatformCompatibility({
      platform: 'win32',
      env: { ComSpec: 'E:\\Tools\\not-cmd.exe' },
    }).getOpenApplicationCommandSpec('notepad.exe').file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(windows.getDirectorySymlinkType()).toBe('junction')
    expect(windows.shouldUseDetachedProcessGroup()).toBe(false)
    expect(windows.getInteractiveShellArgs()).toEqual(['--noprofile', '--norc', '-i'])
    expect(windows.quoteShellArg("中文 $HOME `echo bad` ' \\n"))
      .toBe("'中文 $HOME `echo bad` '\\'' \\n'")

    expect(macOS.getPreferredShellPath()).toBe('/opt/homebrew/bin/zsh')
    expect(macOS.getLoginShellCandidates()).toEqual([
      '/opt/homebrew/bin/zsh',
      '/bin/zsh',
      '/bin/bash',
    ])
    expect(macOS.getShellCommandSpec('echo ready')).toEqual({
      file: '/opt/homebrew/bin/zsh',
      args: ['-lc', 'echo ready'],
    })
    expect(macOS.getDefaultInspectableCommands()).toContain('brew')
  })

  test('owns application, app-data, and background-launch conventions', () => {
    const macOS = new SystemPlatformCompatibility({ platform: 'darwin' })
    const linux = new SystemPlatformCompatibility({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/velaros/.config' },
    })
    const windows = new SystemPlatformCompatibility({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\velaros\\AppData\\Roaming' },
    })

    expect(
      macOS.getOpenPathWithEditorCommandSpec('/tmp/project', {
        darwinApplication: 'Visual Studio Code',
      })
    ).toEqual({
      file: 'open',
      args: ['-a', 'Visual Studio Code', '/tmp/project'],
    })
    expect(macOS.getDefaultAppDataPath('VelarOS', { homeDir: '/Users/velaros' })).toBe(
      '/Users/velaros/Library/Application Support/VelarOS'
    )
    expect(linux.getDefaultAppDataPath('VelarOS')).toBe('/home/velaros/.config/VelarOS')
    expect(windows.getDefaultAppDataPath('VelarOS')).toBe(
      'C:\\Users\\velaros\\AppData\\Roaming\\VelarOS'
    )
    expect(
      linux.getBackgroundShellLaunchCommand({
        command: 'bun run dev',
        logPath: '/tmp/velaros log.txt',
        pidMarker: 'PID:',
        shellPath: '/bin/bash',
      })
    ).toBe(
      "nohup '/bin/bash' -lc 'exec bun run dev' >> '/tmp/velaros log.txt' 2>&1 & printf \"PID:%s\\n\" \"$!\""
    )
  })

  test('owns process inspection and termination command specs', () => {
    const windows = new SystemPlatformCompatibility({ platform: 'win32' })
    const linux = new SystemPlatformCompatibility({ platform: 'linux' })

    expect(windows.getProcessTreeKillCommandSpec(42, 'SIGKILL')).toEqual({
      file: 'taskkill',
      args: ['/PID', '42', '/T', '/F'],
    })
    expect(windows.getTerminateCommand(42, true, { kind: 'git-bash' })).toBe('MSYS_NO_PATHCONV=1 taskkill.exe /PID 42 /T /F')
    expect(windows.getTerminateCommand(42, true, { kind: 'powershell' })).toBe('taskkill.exe /PID 42 /T /F')
    expect(windows.getFallbackTerminateCommand('bun run dev')).toBeNull()
    const windowsProcessList = windows.getProcessListCommandSpec()
    expect(windowsProcessList?.file).toBe('powershell.exe')
    expect(windowsProcessList?.args.join(' ')).toContain('Get-Process -IncludeUserName')
    expect(windowsProcessList?.args.join(' ')).not.toContain('.GetOwner()')
    expect(windows.getOpenPortInspectionCommandSpec()).toEqual({
      file: 'netstat.exe',
      args: ['-ano', '-p', 'tcp'],
    })

  expect(linux.getProcessKillPid(42)).toBe(-42)
  expect(linux.isProcessMissingError({ code: 'ESRCH' })).toBe(true)
  expect(linux.isProcessMissingError({ errno: 3 })).toBe(true)
  expect(linux.isProcessMissingError({ errno: -3 })).toBe(true)
  expect(linux.isProcessMissingError({ code: 'EPERM' })).toBe(false)
    expect(linux.getFallbackTerminateCommand('bun   run dev')).toBe("pkill -f 'bun run dev'")
    expect(linux.getCpuUsageCommandSpec()).toEqual({
      file: 'cat',
      args: ['/proc/stat'],
    })
    expect(linux.getDiskStatsCommandSpec()).toEqual({
      file: 'df',
      args: ['-kP', '/'],
    })
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
    const resolved = resolveSystemShell({ platform: 'win32', env, isFile })
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
    const resolved = resolveSystemShell({ platform: 'win32', env, isFile })
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
    expect(new SystemPlatformCompatibility({ platform: 'win32', env: resolved.env })
      .getPreferredShellPath()).toBe(resolved.shellPath)
  })

  test('accepts an explicit Git Bash executable and diagnoses an unavailable pinned selection', () => {
    const root = 'D:\\Tools\\PortableGit'
    const { isFile } = filesystem(root, 'C:\\Program Files\\Git')
    expect(resolveSystemShell({
      platform: 'win32', env: { VELAROS_GIT_BASH: `${root}\\usr\\bin\\bash.exe` }, isFile,
    }).shellPath).toBe(`${root}\\usr\\bin\\bash.exe`)
    for (const shellPath of ['bash.exe', '.\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe', `${root}\\bin\\sh.exe`]) {
      expect(() => resolveSystemShell({
        platform: 'win32', env: { VELAROS_SHELL_PATH: shellPath }, isFile,
      })).toThrow(SystemShellUnavailableError)
    }
  })

  test('ignores WSL Bash on PATH and rejects incomplete Git installations', () => {
    const root = 'C:\\Program Files\\Git'
    const { files, isFile } = filesystem(root)
    files.add('c:\\windows\\system32\\bash.exe')
    expect(resolveSystemShell({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, isFile })
      .shellPath).toBe(`${root}\\bin\\bash.exe`)
    files.delete('c:\\program files\\git\\usr\\bin\\msys-2.0.dll')
    expect(() => resolveSystemShell({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, isFile }))
      .toThrow('Install Git for Windows')
  })

  test('missing Git can be installed and retried without restarting the process', () => {
    const { files, isFile } = filesystem()
    const options = { platform: 'win32' as const, env: {}, isFile }
    expect(() => resolveSystemShell(options)).toThrow('No working command shell')
    for (const file of filesystem('C:\\Program Files\\Git').files) files.add(file)
    expect(resolveSystemShell(options).shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    files.clear()
    expect(() => resolveSystemShell(options)).toThrow(SystemShellUnavailableError)
  })

  test('keeps POSIX shell selection and environment unchanged', () => {
    const env = { SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', PATH: '/usr/bin:/bin' }
    expect(resolveSystemShell({ platform: 'darwin', env })).toMatchObject({ shellPath: '/bin/zsh', env })
    expect(resolveSystemShell({ platform: 'linux', env, shellPath: '/bin/bash' }))
      .toMatchObject({ shellPath: '/bin/bash', env })
  })
})
