import { describe, expect, test } from 'bun:test'

import { SystemPlatformCompatibility } from '../src/SystemPlatformCompatibility'

describe('SystemPlatformCompatibility', () => {
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
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'echo ready'],
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
    }).getShellCommandSpec('echo ready').file).toBe('C:\\Windows\\System32\\cmd.exe')
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
    expect(windows.getTerminateCommand(42, true)).toBe('taskkill /PID 42 /T /F')
    expect(windows.getFallbackTerminateCommand('bun run dev')).toBeNull()
    expect(windows.getProcessListCommandSpec()?.file).toBe('powershell.exe')
    expect(windows.getOpenPortInspectionCommandSpec()?.file).toBe('powershell.exe')

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
