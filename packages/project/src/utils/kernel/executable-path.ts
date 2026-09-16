/**
 * 解析要启动的可执行文件：**只查 PATH**，拿到绝对路径再启动。
 *
 * Windows 的进程启动语义会先在应用目录和当前工作目录里找同名程序，再查 PATH；内核在项目根里跑 git、rg，
 * 项目里放一个 `git.exe`、`rg.cmd` 就会被优先执行。先按 PATH 解析成绝对路径再交给子进程，这条路就没了。
 * POSIX 上 execvp 本来就只查 PATH，这一步只是让两边语义一致。
 */

import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { ExecutableLookupOptions } from '../../types/provider.js'

/** Windows 上找不到 PATHEXT 时的缺省可执行后缀。 */
const DefaultWindowsExtensions = '.COM;.EXE;.BAT;.CMD'

/** PATH 里的各个目录：Windows 按 `;` 切，其他平台按 `:` 切；空段丢掉。 */
export function executablePathEntries(platform: string, env: NodeJS.ProcessEnv): string[] {
  const separator = platform === 'win32' ? ';' : ':'
  const value = platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    : env.PATH ?? ''
  return value.split(separator).map((entry) => entry.trim()).filter(Boolean)
}

/** 一个命令名可能对应的文件名：Windows 上按 PATHEXT 补后缀（已经带后缀的就是它自己），其他平台就是它自己。 */
export function executableCandidates(command: string, platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32' || win32.extname(command)) return [command]
  const extensions = (Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? DefaultWindowsExtensions)
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
  return [...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
}

/**
 * 把裸命令名解析成 PATH 里的绝对路径；带路径分隔符或绝对路径的命令是调用方点名的那一个，原样交回（返回 undefined）。
 * PATH 里找不到也返回 undefined，调用方照旧把原名交给子进程，失败仍按「命令缺失」处理。
 */
export function resolveExecutableInPath(command: string, options: ExecutableLookupOptions = {}): Optional<string> {
  const name = command.trim()
  if (!name || name.includes('/') || name.includes('\\')) return undefined
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const pathApi = platform === 'win32' ? win32 : posix
  const candidates = executableCandidates(name, platform, env)
  for (const directory of executablePathEntries(platform, env)) {
    for (const candidate of candidates) {
      const absolute = pathApi.join(directory, candidate)
      if (exists(absolute)) return absolute
    }
  }
  return undefined
}
