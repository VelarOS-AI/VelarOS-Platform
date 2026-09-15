/**
 * 平台约定：判断 shell 种类、拼 shell 命令与参数引号、路径文本与 PATH 的小工具。
 * 不 import 任何 Node 模块：跨平台兼容层靠它，渲染进程也会加载。
 */

import { toNullable } from '@velaros-ai/core'

import type { CommandSpec, RuntimePlatform, ShellKind } from '../types/platform.js'

/** Windows 上可信的 CMD 路径；打开文件、启动应用都用它，不信任 PATH 或 ComSpec 里的值。 */
export const WindowsCommandShellPath = 'C:\\Windows\\System32\\cmd.exe'

/** PATHEXT 缺席时 Windows 默认认作可执行文件的后缀。 */
const DefaultWindowsExecutableExtensions = ['.EXE', '.CMD', '.BAT', '.COM']

/** 根据 shell 可执行文件的路径判断它是哪种 shell：pwsh、powershell、cmd、git-bash 或 posix。 */
export function getShellKind(shellPath: string): ShellKind {
  if (/(?:^|[\\/])pwsh(?:\.exe)?$/i.test(shellPath)) return 'pwsh'
  if (/(?:^|[\\/])powershell(?:\.exe)?$/i.test(shellPath)) return 'powershell'
  if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shellPath)) return 'cmd'
  return /(?:^|[\\/])bash\.exe$/i.test(shellPath) ? 'git-bash' : 'posix'
}

/** 判断一个字符是不是路径分隔符（`/` 或 `\`）。 */
export function isPathTextSeparator(character: LooseOptional<string>): boolean {
  return character === '/' || character === '\\'
}

/** 读取当前运行环境的 process 对象；浏览器里没有时返回 null。 */
export function readCurrentProcess(): Nullable<{
  platform?: RuntimePlatform
  env?: NodeJS.ProcessEnv
}> {
  const currentProcess = (
    globalThis as typeof globalThis & {
      process?: { platform?: RuntimePlatform; env?: NodeJS.ProcessEnv }
    }
  ).process

  return toNullable(currentProcess)
}

/** 判断是否 Windows 写法的绝对路径：带盘符（`C:\`、`C:/`）或 UNC（`\\server`）。 */
export function isWindowsAbsolutePathText(path: string): boolean {
  const normalized = path.trim()
  return normalized.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(normalized)
}

/**
 * 按平台把绝对路径文本拆成根与各级名字，折叠 `.` 与 `..`（到根为止）。win32 认 `\` 与 `/`、盘符（`C:\`）、UNC（`\\server\share`）与
 * `\\?\` 长路径前缀；其他平台只认 `/`——反斜杠在 POSIX 上是文件名里的普通字符，不能当分隔符，否则 `/etc\..\root` 会被误算成 `/root`。
 * 不是完整的绝对路径（相对路径、win32 上的 `C:foo` 与只有 `\foo` 的根相对写法）返回 null。
 */
export function splitAbsolutePathText(path: string, platform: RuntimePlatform): Nullable<{ root: string; segments: string[] }> {
  if (platform !== 'win32') return path.startsWith('/') ? { root: '/', segments: collapsePathTextSegments(path.split('/')) } : null
  let text = path.replace(/\\/g, '/')
  if (text.startsWith('//?/') || text.startsWith('//./')) text = text.slice(4)
  if (/^unc\//iu.test(text)) text = `//${text.slice(4)}`
  const drive = /^([A-Za-z]):(?:\/|$)/u.exec(text)
  if (drive) return { root: `${drive[1]}:/`, segments: collapsePathTextSegments(text.slice(drive[0].length).split('/')) }
  const share = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(text)
  if (!share) return null
  return { root: `//${share[1]}/${share[2]}/`, segments: collapsePathTextSegments(text.slice(share[0].length).split('/')) }
}

/** 折叠路径的各级名字：丢掉空段与 `.`，`..` 退回上一级，退到根就停在根。 */
function collapsePathTextSegments(parts: readonly string[]): string[] {
  const segments: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments
}

/** 去掉路径文本首尾的分隔符。 */
export function stripWrappingPathSeparators(path: string): string {
  let start = 0
  let end = path.length
  while (isPathTextSeparator(path[start])) start += 1
  while (end > start && isPathTextSeparator(path[end - 1])) end -= 1
  return path.slice(start, end)
}

/** 读取 PATH 环境变量的值，兼容 Windows 上 `Path`、`path` 的写法；没有时返回空串。 */
export function readPathEnvironmentValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? ''
}

/** 按 PATHEXT 列出一个命令名在 Windows 上可能对应的文件名；命令名已经带可执行后缀时只返回它自己。 */
export function buildWindowsExecutableCandidates(commandName: string, pathExtValue?: string): string[] {
  const pathExts = (pathExtValue?.trim() || DefaultWindowsExecutableExtensions.join(';'))
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith('.') ? value : `.${value}`))
  const loweredCommand = commandName.toLowerCase()
  if (pathExts.some((ext) => loweredCommand.endsWith(ext.toLowerCase()))) return [commandName]
  return Array.from(new Set([commandName, ...pathExts.map((ext) => `${commandName}${ext}`)]))
}

/** 生成用 Windows PowerShell 执行一段脚本的启动规格，输出统一为无 BOM 的 UTF-8。 */
export function buildWindowsPowerShellCommandSpec(command: string): CommandSpec {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${command}`],
  }
}

/** 按 POSIX shell 规则给一个值加单引号，值里的单引号转义成 `'\''`。 */
export function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** 取 POSIX 平台的默认 shell：优先 SHELL 环境变量，没有时 macOS 用 zsh、其他用 sh。 */
export function preferredPosixShellPath(platform: RuntimePlatform, env: NodeJS.ProcessEnv): string {
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

/** 生成「用某个 shell 执行一段命令」的启动规格：按 shell 种类拼参数，统一 UTF-8 输出；PowerShell 里命令失败时如实返回非零退出码。 */
export function buildShellCommandSpec(command: string, file: string, kind: ShellKind): CommandSpec {
  if (kind === 'pwsh' || kind === 'powershell') return {
    file,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
      `$ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0; & { ${command}\n }; ` +
      `if (-not $?) { if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }; exit $LASTEXITCODE`],
  }
  if (kind === 'cmd') return {
    file,
    // /c 后面的字符串由 CMD 自己解析，按 CRT 规则转义会弄坏里面的引号。
    args: ['/d', '/s', '/v:off', '/c', `"chcp 65001 >nul & ${command}"`],
    windowsVerbatimArguments: true,
  }
  return { file, args: kind === 'git-bash' ? ['--noprofile', '--norc', '-c', command] : ['-lc', command] }
}

/** 按 shell 种类给一个参数加引号；CMD 下带换行、NUL、`%` 这类无法安全转义的字符时抛错，要求改用原生 argv 执行。 */
export function quoteShellArgument(value: string, kind: ShellKind): string {
  if (kind === 'pwsh' || kind === 'powershell') return `'${value.replace(/'/g, "''")}'`
  if (kind === 'cmd') {
    if (/[\r\n\0%]/.test(value)) throw new Error('CMD 里这个参数只能用原生 file + argv 的方式执行，不能拼进命令行。')
    return `"${value.replace(/"/g, '""')}"`
  }
  return quotePosixSingle(value)
}
