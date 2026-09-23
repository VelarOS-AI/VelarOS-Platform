import { describe, expect, test } from 'bun:test'

import { createPlatform } from '../index.js'

describe('PlatformCompatibility', () => {
  test('owns portable path primitives for product hosts', () => {
    const windows = createPlatform({ platform: 'win32' })

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

  test('路径文本包含判断：按平台规整、不越过根、给出相对路径', () => {
    const linux = createPlatform({ platform: 'linux' })
    expect(linux.relativePathTextInside('/work/app', '/work/app')).toBe('.')
    expect(linux.relativePathTextInside('/work/app/src/./a.ts', '/work/app/')).toBe('src/a.ts')
    expect(linux.isPathTextInside('/work/app/..foo/a', '/work/app')).toBe(true)
    expect(linux.isPathTextInside('/work/app/../etc', '/work/app')).toBe(false)
    expect(linux.isPathTextInside('/work/application', '/work/app')).toBe(false)
    expect(linux.isPathTextInside('/../../work/app/x', '/work/app')).toBe(true)
    expect(linux.isPathTextInside('/anything', '/')).toBe(true)
    expect(linux.isPathTextInside('work/app/x', '/work/app')).toBe(false)
    expect(linux.isPathTextInside('/work/App/x', '/work/app')).toBe(false)
    // POSIX 上反斜杠是文件名字符：这是根目录下一个名字很怪的文件，不是 /work/app
    expect(linux.isPathTextInside('/etc\\..\\work\\app\\x', '/work/app')).toBe(false)

    const macOS = createPlatform({ platform: 'darwin' })
    expect(
      macOS.relativePathTextInside('/Users/Example/Project/Src', '/users/example/project')
    ).toBe('Src')
    expect(
      macOS.isPathTextInside('/Users/Example/Project', '/users/example/project', {
        caseSensitive: true,
      })
    ).toBe(false)

    const windows = createPlatform({ platform: 'win32' })
    expect(windows.relativePathTextInside('c:\\Work\\App\\src\\a.ts', 'C:/work/app')).toBe(
      'src/a.ts'
    )
    expect(windows.isPathTextInside('C:\\work\\app\\..\\..\\Windows', 'C:\\work\\app')).toBe(false)
    expect(windows.isPathTextInside('D:\\work\\app', 'C:\\work\\app')).toBe(false)
    expect(
      windows.relativePathTextInside('\\\\server\\share\\team\\doc.md', '\\\\SERVER\\share')
    ).toBe('team/doc.md')
    expect(windows.relativePathTextInside('\\\\?\\C:\\work\\app\\a', 'C:\\work\\app')).toBe('a')
    expect(
      windows.relativePathTextInside('\\\\?\\UNC\\server\\share\\a', '\\\\server\\share')
    ).toBe('a')
    expect(windows.isPathTextInside('C:', 'C:\\')).toBe(true)
    expect(windows.isPathTextInside('C:foo', 'C:\\')).toBe(false)
    expect(windows.isPathTextInside('\\work\\app', '\\work')).toBe(false)
  })

  test('owns shell and executable selection across platforms', () => {
    const windows = createPlatform({
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATH: 'C:\\bin;D:\\tools',
        PATHEXT: '.EXE;.CMD',
        VELAROS_GIT_BASH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    })
    const macOS = createPlatform({
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
    expect(
      createPlatform({
        platform: 'win32',
        env: { ComSpec: 'C:\\Users\\attacker\\cmd.exe' },
      }).getOpenExternalFallbackSpec('https://example.com')
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'start', '', 'https://example.com'],
    })
    expect(
      createPlatform({
        platform: 'win32',
        env: {
          ComSpec: 'cmd.exe',
          COMSPEC: 'powershell.exe',
          SystemRoot: 'D:\\CustomWindows',
        },
      }).getShellCommandSpec('echo ready').args
    ).toEqual(['/d', '/s', '/v:off', '/c', '"chcp 65001 >nul & echo ready"'])
    expect(
      createPlatform({
        platform: 'win32',
        env: { ComSpec: '.\\cmd.exe', WINDIR: 'relative-root' },
      }).getPreferredShellPath()
    ).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(
      createPlatform({
        platform: 'win32',
        env: { ComSpec: 'E:\\Tools\\not-cmd.exe' },
      }).getOpenApplicationCommandSpec('notepad.exe').file
    ).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(windows.getDirectorySymlinkType()).toBe('junction')
    expect(windows.shouldUseDetachedProcessGroup()).toBe(false)
    expect(windows.getInteractiveShellArgs()).toEqual(['--noprofile', '--norc', '-i'])
    expect(windows.quoteShellArg("中文 $HOME `echo bad` ' \\n")).toBe(
      "'中文 $HOME `echo bad` '\\'' \\n'"
    )

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
    const macOS = createPlatform({ platform: 'darwin' })
    const linux = createPlatform({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/velaros/.config' },
    })
    const windows = createPlatform({
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
    const windows = createPlatform({ platform: 'win32' })
    const linux = createPlatform({ platform: 'linux' })

    expect(windows.getProcessTreeKillCommandSpec(42, 'SIGKILL')).toEqual({
      file: 'taskkill',
      args: ['/PID', '42', '/T', '/F'],
    })
    expect(windows.getTerminateCommand(42, true, { kind: 'git-bash' })).toBe(
      'MSYS_NO_PATHCONV=1 taskkill.exe /PID 42 /T /F'
    )
    expect(windows.getTerminateCommand(42, true, { kind: 'powershell' })).toBe(
      'taskkill.exe /PID 42 /T /F'
    )
    expect(windows.getFallbackTerminateCommand('bun run dev')).toBeNull()
    const windowsProcessList = windows.getProcessListCommandSpec()
    expect(windowsProcessList).toEqual({ file: 'tasklist.exe', args: ['/FO', 'CSV', '/NH'] })
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
