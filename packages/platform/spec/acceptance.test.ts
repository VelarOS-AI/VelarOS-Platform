/**
 * 平台约定的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createPlatform, currentPlatform } from '../src/exports/index'
import { velarosSharedResources } from '../src/exports/shared-resources'

describe('跨平台兼容层', () => {
  test('INV-2 在一台机器上按指定平台回答，不看当前进程', () => {
    const windows = createPlatform({ platform: 'win32', env: { PATH: 'C:\\bin;D:\\tools', PATHEXT: '.EXE;.CMD' } })
    expect(windows.isWindows()).toBe(true)
    expect(windows.getPathEntries()).toEqual(['C:\\bin', 'D:\\tools'])
    expect(windows.buildExecutableCandidates('git')).toEqual(['git', 'git.EXE', 'git.CMD'])
    expect(windows.getShellCommandSpec('dir', { shellPath: 'C:\\Windows\\System32\\cmd.exe' })).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', windowsVerbatimArguments: true })
    expect(windows.getProcessTreeKillCommandSpec(42, 'SIGKILL')).toEqual({ file: 'taskkill', args: ['/PID', '42', '/T', '/F'] })

    const macOS = createPlatform({ platform: 'darwin', env: { SHELL: '/bin/zsh' } })
    expect(macOS.isMacOS()).toBe(true)
    expect(macOS.getShellCommandSpec('echo ready')).toEqual({ file: '/bin/zsh', args: ['-lc', 'echo ready'] })
    expect(macOS.getProcessTreeKillCommandSpec(42, 'SIGKILL')).toBeNull()
    expect(macOS.getDefaultAppDataPath('VelarOS', { homeDir: '/Users/example' })).toBe('/Users/example/Library/Application Support/VelarOS')

    expect(currentPlatform.getPlatform()).toBe(process.platform)
  })
})

describe('共享资源目录', () => {
  test('INV-3 覆盖变量整体接管共享数据根，资源与账号目录固定接在它下面', () => {
    const env = { VELAROS_SHARED_DATA_ROOT: '/portable/VelarOS' }
    expect(velarosSharedResources.dataRoot({ platform: 'darwin', env, homeDirectory: '/ignored' })).toBe('/portable/VelarOS')
    expect(velarosSharedResources.resourcesRoot({ platform: 'linux', env, homeDirectory: '/ignored' })).toBe(join('/portable/VelarOS', 'shared', 'resources'))
    expect(velarosSharedResources.accountRoot({ platform: 'win32', env, homeDirectory: 'C:\\ignored' })).toBe(join('/portable/VelarOS', 'shared', 'account', 'v1'))
    expect(velarosSharedResources.dataRoot({ platform: 'linux', env: {}, homeDirectory: '/home/example' })).toBe(join('/home/example', '.local', 'share', 'VelarOS'))
  })
})
