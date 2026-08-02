import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'

import type { ToolContext } from '../Types.js'

/**
 * 系统写入的敏感路径边界。
 * 临时目录不触发敏感路径审批；Windows 路径按大小写不敏感规则比较。
 */

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
 * 该绝对路径的写入或修改是否触及系统敏感区；命中时必须走统一审批。
 *
 * 命中条件：①系统级根目录；②用户主目录下的隐藏文件或目录；③系统启动项目录。
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
 * 系统写入与编辑共用同一道敏感路径确认门，避免不同入口产生权限旁路。
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
