import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { isWindowsCommandAvailable } from '../utils/kernel/command-requirements'
import {
  executableCandidates,
  executablePathEntries,
  resolveExecutableInPath,
} from '../utils/kernel/executable-path'

/** win32 语义下的一份环境：PATH 用分号分隔，PATHEXT 决定候选后缀。 */
const windowsEnv = { Path: 'C:\\tools;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD' }

test('PATH 按平台分隔符切开，Windows 上大小写不敏感地认 Path', () => {
  expect(executablePathEntries('win32', windowsEnv)).toEqual([
    'C:\\tools',
    'C:\\Program Files\\Git\\cmd',
  ])
  expect(executablePathEntries('darwin', { PATH: '/usr/bin:/opt/homebrew/bin' })).toEqual([
    '/usr/bin',
    '/opt/homebrew/bin',
  ])
})

test('Windows 上按 PATHEXT 补后缀，其他平台就是命令名本身', () => {
  expect(executableCandidates('git', 'win32', windowsEnv)).toEqual([
    'git.com',
    'git.exe',
    'git.bat',
    'git.cmd',
  ])
  expect(executableCandidates('git.exe', 'win32', windowsEnv)).toEqual(['git.exe'])
  expect(executableCandidates('git', 'darwin', { PATH: '/usr/bin' })).toEqual(['git'])
})

test('Windows 上只查 PATH：工作目录里的同名 git.exe 不会被选中', () => {
  // 工作目录里有个 git.exe（模型往项目里放一个就成立），PATH 里也有真的 git。
  const present = new Set(['git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'])
  const resolved = resolveExecutableInPath('git', {
    platform: 'win32',
    env: windowsEnv,
    exists: (path) => present.has(path),
  })
  expect(resolved).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
})

test('PATH 里前面的目录优先；找不到时返回 undefined，调用方照旧交原名给子进程', () => {
  const present = new Set(['C:\\tools\\rg.exe', 'C:\\Program Files\\Git\\cmd\\rg.exe'])
  expect(
    resolveExecutableInPath('rg', {
      platform: 'win32',
      env: windowsEnv,
      exists: (path) => present.has(path),
    })
  ).toBe('C:\\tools\\rg.exe')
  expect(
    resolveExecutableInPath('nope', { platform: 'win32', env: windowsEnv, exists: () => false })
  ).toBeUndefined()
})

test('调用方点名的路径（绝对或带分隔符）原样交回，不去 PATH 里改写它', () => {
  const options = { platform: 'win32', env: windowsEnv, exists: () => true }
  expect(resolveExecutableInPath('C:\\tools\\git.exe', options)).toBeUndefined()
  expect(resolveExecutableInPath('.\\scripts\\build.cmd', options)).toBeUndefined()
  expect(
    resolveExecutableInPath('./scripts/build.sh', {
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      exists: () => true,
    })
  ).toBeUndefined()
  expect(resolveExecutableInPath('  ', options)).toBeUndefined()
})

test('POSIX 上同样只查 PATH', () => {
  const present = new Set(['/opt/homebrew/bin/rg'])
  expect(
    resolveExecutableInPath('rg', {
      platform: 'darwin',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      exists: (path) => present.has(path),
    })
  ).toBe('/opt/homebrew/bin/rg')
})

test('Windows command availability honors mixed-case Path and PathExt and excludes cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-command-'))
  try {
    await writeFile(join(root, 'git.custom'), '')
    expect(isWindowsCommandAvailable('git', undefined, { Path: root, pAtHeXt: '.CUSTOM' })).toBe(
      true
    )
    expect(
      isWindowsCommandAvailable('missing', undefined, { Path: root, pAtHeXt: '.CUSTOM' })
    ).toBe(false)
    expect(isWindowsCommandAvailable('git', root, { Path: '', pAtHeXt: '.CUSTOM' })).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
