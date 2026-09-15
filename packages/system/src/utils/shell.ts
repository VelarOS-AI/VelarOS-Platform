/**
 * shell：列出本机的 shell 候选与它们的运行环境、把原生调用变成启动规格、cmd 参数转义、原生调用的展示文本。
 */

import { statSync } from 'node:fs'
import { win32 } from 'node:path'

import { Log } from '@velaros-ai/core'
import { createPlatform, currentPlatform } from '@velaros-ai/platform'
import type { CommandSpec } from '@velaros-ai/platform/contracts'

import type { ResolvedSystemShell } from '../contract/commands.js'
import type { SystemShellDescriptor, SystemShellKind, SystemShellRecommendation } from '../contract/system.js'
import type { ResolveSystemShellOptions } from '../interface/internal.js'


const shellNames: Record<SystemShellKind, string> = {
  'git-bash': 'Git Bash', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell',
  cmd: 'CMD', posix: 'POSIX shell',
}

const gitRecommendation: SystemShellRecommendation = {
  code: 'INSTALL_GIT_BASH',
  message: '推荐安装 Git for Windows，以获得 Git Bash 和一致的 Unix 命令工具。',
  url: 'https://git-scm.com/download/win',
}

/** 判断路径是否是存在的普通文件；读不到时返回 false。 */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    // 路径缺失或暂不可读时跳过该候选，继续检查其他可用 Shell。
    log.debug('shell candidate unavailable', { path, error })
    return false
  }
}

/** 按大小写不敏感的方式读取一个 Windows 环境变量。 */
export function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): LooseOptional<string> {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
}

/** 判断是否是带盘符或 UNC 前缀的 Windows 绝对路径。 */
export function isAbsoluteWindowsPath(path: string): boolean {
  return win32.isAbsolute(path) && (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\'))
}

/** 读出 Windows PATH 里的各个目录，去掉引号与空项。 */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (readWindowsEnv(env, 'PATH') ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

/** 规整 Windows 路径：去掉外层引号，标准化分隔符。 */
export function normalizeWindowsPath(path: string): string {
  return win32.normalize(path.trim().replace(/^"(.*)"$/, '$1'))
}

/** 按 Windows 规则给路径去重：不区分大小写，忽略末尾分隔符。 */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = normalizeWindowsPath(path).replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 确认一个 bash.exe 属于完整的 Git for Windows 安装，返回安装根目录；不是则返回 undefined。 */
export function gitRootForBash(shellPath: string, isFile: (path: string) => boolean): LooseOptional<string> {
  if (!isAbsoluteWindowsPath(shellPath) || win32.basename(shellPath).toLowerCase() !== 'bash.exe')
    return undefined
  const binDir = win32.dirname(shellPath)
  if (win32.basename(binDir).toLowerCase() !== 'bin') return undefined
  const parent = win32.dirname(binDir)
  const roots = win32.basename(parent).toLowerCase() === 'usr'
    ? [parent, win32.dirname(parent)] : [parent]
  // Git for Windows 安装目录应同时包含启动器与 MSYS 运行时。
  // 由此排除 Windows 的 WSL bash.exe 和无关的独立 Bash 安装。
  if (!isFile(shellPath)) return undefined
  return roots.find((root) => isFile(win32.join(root, 'git-bash.exe')) &&
    isFile(win32.join(root, 'usr', 'bin', 'msys-2.0.dll')) &&
    ['cmd', 'bin', 'mingw64\\bin', 'mingw32\\bin']
      .some((directory) => isFile(win32.join(root, directory, 'git.exe'))))
}

/** 列出 Windows 上 Git Bash 可能在的位置：Program Files、用户目录，以及 PATH 里 git 所在目录的附近。 */
function gitBashCandidates(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string[] {
  const programRoots = [
    readWindowsEnv(env, 'ProgramW6432'),
    readWindowsEnv(env, 'ProgramFiles'),
    readWindowsEnv(env, 'ProgramFiles(x86)'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((path): path is string => !!path && isAbsoluteWindowsPath(path))
  const roots = programRoots.map((path) => win32.join(path, 'Git'))
  const localAppData = readWindowsEnv(env, 'LOCALAPPDATA')
  if (localAppData && isAbsoluteWindowsPath(localAppData)) {
    roots.push(win32.join(localAppData, 'Programs', 'Git'), win32.join(localAppData, 'Git'))
  }
  const candidates = roots.map((root) => win32.join(root, 'bin', 'bash.exe'))
  for (const entry of pathEntries(env)) {
    if (!isAbsoluteWindowsPath(entry)) continue
    candidates.push(win32.join(entry, 'bash.exe'))
    if (isFile(win32.join(entry, 'git.exe'))) {
      // Git 可以通过 cmd、bin、mingw64/bin 或 mingw32/bin 目录加入 PATH。
      candidates.push(
        win32.join(entry, '..', 'bin', 'bash.exe'),
        win32.join(entry, '..', '..', 'bin', 'bash.exe')
      )
    }
  }
  return uniquePaths(candidates)
}

/** 为 Git Bash 生成运行环境：PATH 优先 Git 自带工具，统一 UTF-8，移除会干扰的变量。 */
function gitBashEnvironment(
  env: NodeJS.ProcessEnv,
  shellPath: string,
  root: string,
  isFile: (path: string) => boolean
): NodeJS.ProcessEnv {
  const result = { ...env }
  const replacedKeys = new Set([
    'PATH', 'LANG', 'LC_ALL', 'SHELL', 'VELAROS_GIT_BASH', 'BASH_ENV', 'ENV',
    'PYTHONIOENCODING', 'PYTHONUTF8',
    'MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL', 'MSYS2_ENV_CONV_EXCL',
  ])
  for (const key of Object.keys(result)) {
    if (replacedKeys.has(key.toUpperCase())) delete result[key]
  }
  const gitPath = [win32.join(root, 'usr', 'bin')]
  for (const arch of ['mingw64', 'mingw32']) {
    if (isFile(win32.join(root, arch, 'bin', 'git.exe'))) gitPath.push(win32.join(root, arch, 'bin'))
  }
  gitPath.push(win32.join(root, 'bin'), win32.join(root, 'cmd'))
  return {
    ...result,
    PATH: uniquePaths([...gitPath, ...pathEntries(env)]).join(';'),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    SHELL: shellPath,
  }
}

/** 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的优先顺序列出 Windows 上的 shell 候选。 */
export function windowsCandidates(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): string[] {
  const configuredGit = readWindowsEnv(env, 'VELAROS_GIT_BASH')?.trim()
  const candidates = [
    ...(configuredGit ? [normalizeWindowsPath(configuredGit)] : []),
    ...gitBashCandidates(env, isFile),
  ]
  const programFiles = readWindowsEnv(env, 'ProgramFiles') || 'C:\\Program Files'
  candidates.push(win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  for (const entry of pathEntries(env)) {
    if (isAbsoluteWindowsPath(entry)) candidates.push(win32.join(entry, 'pwsh.exe'))
  }
  const windowsRoot = readWindowsEnv(env, 'SystemRoot') || readWindowsEnv(env, 'WINDIR') || 'C:\\Windows'
  candidates.push(win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  candidates.push(win32.join(windowsRoot, 'System32', 'cmd.exe'))
  return uniquePaths(candidates)
}

/** 为一个 shell 生成完整描述：种类、名称、启动参数、运行环境与安装建议。 */
export function describeShell(shellPath: string, env: NodeJS.ProcessEnv, isFile: (path: string) => boolean): ResolvedSystemShell {
  const kind = currentPlatform.getShellKind(shellPath)
  const gitRoot = kind === 'git-bash' ? gitRootForBash(shellPath, isFile) : undefined
  const shellEnv = gitRoot ? gitBashEnvironment(env, shellPath, gitRoot, isFile) : { ...env }
  if (kind !== 'posix') {
    for (const key of Object.keys(shellEnv)) {
      if (['PYTHONUTF8', 'PYTHONIOENCODING'].includes(key.toUpperCase())) delete shellEnv[key]
    }
    shellEnv.PYTHONUTF8 = '1'
    shellEnv.PYTHONIOENCODING = 'utf-8'
  }
  // Windows 环境变量键不区分大小写，每个受管键只发布一种拼写。
  for (const key of Object.keys(shellEnv)) {
    if (['VELAROS_SHELL_KIND', 'VELAROS_SHELL_PATH', 'VELAROS_SHELL_READINESS', 'VELAROS_SHELL_VERSION']
      .includes(key.toUpperCase())) delete shellEnv[key]
  }
  shellEnv.VELAROS_SHELL_KIND = kind
  shellEnv.VELAROS_SHELL_PATH = shellPath
  shellEnv.VELAROS_SHELL_READINESS = 'detected'
  const args = kind === 'cmd' ? ['/d', '/s', '/v:off', '/c']
    : kind === 'git-bash' ? ['--noprofile', '--norc', '-c']
      : kind === 'posix' ? ['-lc']
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
  return {
    kind, name: shellNames[kind], shellPath, args, env: shellEnv, readiness: 'detected', version: null,
    recommendation: kind === 'cmd' || kind === 'pwsh' || kind === 'powershell' ? { ...gitRecommendation } : null,
  }
}

/** cmd.exe 里有特殊含义、转义时要加 `^` 的字符。 */
const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g

/** 把一个参数转义成 cmd.exe 能原样收到的形式；npm 的 .cmd 包装需要双重转义。 */
export function escapeCmdArgument(value: string, doubleEscape: boolean): string {
  // 改编自 cross-spawn（MIT 许可）：github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js
  const quoted = `"${value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')}"`
  const escaped = quoted.replace(cmdMetaCharacters, '^$1')
  return doubleEscape ? escaped.replace(cmdMetaCharacters, '^$1') : escaped
}

/** 把宿主生成的原生调用写成审批与日志里展示的命令文本。 */
export function describeSystemNativeCommand(input: { file: string; args: string[] }): string {
  return [input.file, ...input.args].map((value) => JSON.stringify(value)).join(' ')
}

/**
 * 列出本机可用的 shell 候选，只查文件、不试跑。
 * POSIX 只有一个：指定的 shellPath 或默认 shell。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序，逐个核对文件存在、种类符合、Git Bash 安装完整。
 */
export function detectSystemShells(options: ResolveSystemShellOptions): ResolvedSystemShell[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? isRegularFile
  if (platform !== 'win32') return [describeShell(options.shellPath || createPlatform({ platform, env }).getPreferredShellPath(env), env, isFile)]
  const selected = options.shellPath || readWindowsEnv(env, 'VELAROS_SHELL_PATH')
  const candidates = selected ? [normalizeWindowsPath(selected)] : windowsCandidates(env, isFile)
  const result: ResolvedSystemShell[] = []
  for (const candidate of candidates) {
    if (!isAbsoluteWindowsPath(candidate) || !isFile(candidate)) continue
    const kind = currentPlatform.getShellKind(candidate)
    if (kind === 'posix' || (options.kind && kind !== options.kind)) continue
    if (kind === 'git-bash' && !gitRootForBash(candidate, isFile)) continue
    result.push(describeShell(candidate, env, isFile))
  }
  return result
}

/**
 * 把原生调用（可执行文件加参数数组）变成启动规格，参数原样到达，不经过 shell 解析。
 * 绕开 MSYS 的路径改写；.cmd 与 .bat 显式交给 cmd.exe 并逐个转义参数；PowerShell 下的 .ps1 交给 PowerShell；Git Bash 下的脚本交给 bash。
 * 环境变量叠加在 shell 的环境上，Windows 上按不区分大小写覆盖。
 */
export function buildSystemNativeCommandSpec(
  input: { file: string; args: string[]; env?: NodeJS.ProcessEnv },
  shell: ResolvedSystemShell
): CommandSpec & { env: NodeJS.ProcessEnv } {
  const env = { ...shell.env }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (shell.kind !== 'posix') for (const previous of Object.keys(env)) {
      if (previous.toUpperCase() === key.toUpperCase()) delete env[previous]
    }
    env[key] = value
  }
  const file = shell.kind !== 'posix' && !win32.extname(input.file) && isRegularFile(`${input.file}.cmd`)
    ? `${input.file}.cmd` : input.file
  if (/\.(?:bat|cmd)$/i.test(file) && shell.kind !== 'posix') {
    const root = readWindowsEnv(env, 'SystemRoot') || 'C:\\Windows'
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
    const command = [win32.normalize(file).replace(cmdMetaCharacters, '^$1'),
      ...input.args.map((value) => escapeCmdArgument(value, doubleEscape))].join(' ')
    return {
      file: win32.join(root, 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/v:off', '/c', `"chcp 65001 >nul & ${command}"`],
      env, windowsVerbatimArguments: true,
    }
  }
  if (/\.ps1$/i.test(file) && (shell.kind === 'pwsh' || shell.kind === 'powershell')) {
    const command = `& ${[file, ...input.args].map((arg) => currentPlatform.quoteShellArg(arg, { kind: shell.kind })).join(' ')}`
    return { ...currentPlatform.getShellCommandSpec(command, { shellPath: shell.shellPath, kind: shell.kind }), env }
  }
  if (shell.kind === 'git-bash' && isRegularFile(file) && !/\.(?:exe|com)$/i.test(file)) return {
    file: shell.shellPath, args: ['--noprofile', '--norc', file.replace(/\\/g, '/'), ...input.args],
    env: { ...env, MSYS2_ARG_CONV_EXCL: '*' },
  }
  return { file, args: [...input.args], env }
}

/** 把解析出的 shell 缩成命令结果里展示的描述：种类、名称、路径、参数、就绪状态、版本、安装建议，不带环境变量。 */
export function toShellDescriptor(shell: SystemShellDescriptor): SystemShellDescriptor {
  return { kind: shell.kind, name: shell.name, shellPath: shell.shellPath, args: shell.args,
    readiness: shell.readiness, version: shell.version, recommendation: shell.recommendation }
}

const log = Log.tag('SystemShell')
