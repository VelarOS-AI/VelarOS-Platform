import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../Types.js'

import { resolveSystemPathInput } from './Filesystem.js'

interface SensitiveSystemMutationPathOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  tempDir?: string
  env?: NodeJS.ProcessEnv
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

function comparisonPath(value: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isPathInsideRoot(
  candidatePath: string,
  rootPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const resolvedCandidate = comparisonPath(candidatePath, platform)
  const resolvedRoot = comparisonPath(rootPath, platform)
  const separator = pathApi(platform).sep
  if (resolvedCandidate === resolvedRoot) return true
  return resolvedCandidate.startsWith(`${resolvedRoot}${separator}`)
}

// scratch/临时目录永远豁免确认（与 bash 默认 sandbox cwd 一致）。
const ScratchRootPrefixes = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'] as const
// 系统级目录：写入可能影响系统行为、二进制或全局配置。
const SensitiveSystemRootPrefixes = [
  '/etc',
  '/private/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/opt',
  '/boot',
  '/var',
  '/private/var',
] as const

function isWithinAnyRoot(
  candidatePath: string,
  roots: readonly string[],
  platform: NodeJS.Platform
): boolean {
  return roots.some((root) => isPathInsideRoot(candidatePath, root, platform))
}

function windowsSensitiveRoots(env: NodeJS.ProcessEnv): string[] {
  const systemDrive = env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:'
  return [
    env.SystemRoot ?? env.SYSTEMROOT ?? `${systemDrive}\\Windows`,
    env.ProgramFiles ?? env.PROGRAMFILES,
    env['ProgramFiles(x86)'] ?? env.PROGRAMFILES_X86,
    env.ProgramData ?? env.PROGRAMDATA ?? `${systemDrive}\\ProgramData`,
  ].filter((value): value is string => !!value?.trim())
}

/**
 * 该绝对路径的写/改是否触及系统敏感区——需要与 bash 的危险写入一致地走确认。
 *
 * 命中条件：①系统级根目录（Unix 系统目录，或 Windows/System32、Program Files、ProgramData）；
 * ②用户主目录下的 dotfile/dot 目录；③macOS LaunchAgents/LaunchDaemons 与 Windows Startup。
 * 临时目录始终豁免；Windows 路径按大小写不敏感规则比较。
 */
export function isSensitiveSystemMutationPath(
  resolvedPath: string,
  options: SensitiveSystemMutationPathOptions = {}
): boolean {
  const platform = options.platform ?? process.platform
  const paths = pathApi(platform)
  const abs = paths.resolve(resolvedPath)
  const temp = options.tempDir ?? tmpdir()
  const scratchRoots = platform === 'win32' ? [temp] : [temp, ...ScratchRootPrefixes]
  if (isWithinAnyRoot(abs, scratchRoots, platform)) return false

  if (platform === 'win32') {
    if (comparisonPath(abs, platform) === comparisonPath(paths.parse(abs).root, platform))
      return true
    if (isWithinAnyRoot(abs, windowsSensitiveRoots(options.env ?? process.env), platform))
      return true
  } else if (isWithinAnyRoot(abs, SensitiveSystemRootPrefixes, platform)) return true

  const home = options.homeDir ?? homedir()
  if (home && isPathInsideRoot(abs, home, platform)) {
    const relativeSegments = paths.relative(home, abs).split(paths.sep)
    const firstSegment = relativeSegments[0] ?? ''
    if (firstSegment.startsWith('.')) return true
    if (platform === 'win32') {
      const normalizedSegments = relativeSegments.map((segment) => segment.toLowerCase())
      if (
        normalizedSegments
          .join('\\')
          .startsWith('appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup')
      )
        return true
    } else if (
      relativeSegments[0] === 'Library' &&
      (relativeSegments[1] === 'LaunchAgents' || relativeSegments[1] === 'LaunchDaemons')
    )
      return true
  }
  return false
}

/**
 * 写/改系统敏感路径前的确认门控，补齐 write/edit 相对 bash 缺失的那道闸：
 * bash 对工作区外的绝对路径写入会要求确认，直连的 write/edit 此前完全没有，等于旁路。
 */
export async function confirmSensitiveSystemMutation(
  ctx: ToolContext,
  resolvedPath: string,
  action: 'write' | 'edit'
): Promise<void> {
  if (!isSensitiveSystemMutationPath(resolvedPath)) return

  // 审批统一走宿主注入的 ApprovalPort；本包不假设具体确认 UI 或运行模式。
  // autonomous 与后台 never-ask 的自动批准；execution 为空的宿主（web 桥/无人值守）得到设计式
  // deny——敏感路径写入按「无审批通道即拒绝」处理，不再对 ~/.ssh、/etc、LaunchAgents 等 fail-open。
  const verb = action === 'write' ? '写入/覆盖' : '修改'
  await ctx.approval.awaitConfirmation(
    `即将${verb}系统敏感路径：\n${resolvedPath}\n\n该路径位于系统目录或主目录的配置/凭证区（如 ~/.ssh、shell 启动文件、/etc 等），可能影响登录、凭证或系统行为。确认继续？`,
    ctx.abortSignal,
    { approvalRisk: 'high', riskScope: 'system-mutation:sensitive-path' }
  )
}

/** 写类 atomic 工具不得直接修改当前 active workspace root 内的项目文件。 */
export function assertAtomicWritePathOutsideActiveWorkspace(path: string, ctx: ToolContext): void {
  const activeRoot = ctx.system.getOverview().activeWorkspaceRoot?.trim()
  if (!activeRoot) return

  const resolvedPath = resolveSystemPathInput(path)
  if (!isPathInsideRoot(resolvedPath, activeRoot)) return

  throw new AppError(
    'VALIDATION',
    `Path is inside the active workspace root (${activeRoot}). Use workspace-edit tools instead of atomic write tools.`
  )
}

export function assertBashCwdOutsideActiveWorkspace(
  cwd: string | undefined,
  ctx: ToolContext
): void {
  if (!ctx.hasWorkspaceRoot?.()) return

  const activeRoot = ctx.system.getOverview().activeWorkspaceRoot?.trim()
  if (!activeRoot) return

  if (!cwd?.trim()) {
    throw new AppError(
      'VALIDATION',
      `bash 当前有 active workspace root (${activeRoot})，未显式 cwd 的命令可能绕过工作区门控；请改用 ws_run_command，或为系统级命令传入工作区外 cwd。`
    )
  }

  const resolvedCwd = resolveSystemPathInput(cwd)
  if (!isPathInsideRoot(resolvedCwd, activeRoot)) return

  throw new AppError(
    'VALIDATION',
    `bash cwd 位于 active workspace root (${activeRoot}) 内；请改用 ws_run_command。`
  )
}
