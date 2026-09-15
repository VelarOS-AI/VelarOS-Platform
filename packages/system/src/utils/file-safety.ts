/**
 * 文件安全：判断路径是否在根目录内、是否属于系统敏感区、是否是凭证文件，写入敏感路径和读凭证之前向用户要确认。
 */

import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'

import { createApprovalOperationKey } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'

import type { SystemToolContext } from '../interface/requires.js'

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

/** 按平台取 posix 或 win32 的路径工具。 */
function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

/** 把路径解析成可比较的形式：Windows 和 macOS 的卷默认不区分大小写，统一小写比较。 */
function comparisonPath(value: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(value)
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
}

/** 判断一个路径是否在某个根目录之内（含根目录本身），Windows 上不区分大小写。 */
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

/** 判断路径是否在任一给定的根目录之内。 */
function isWithinAnyRoot(
  candidatePath: string,
  roots: readonly string[],
  platform: NodeJS.Platform
): boolean {
  return roots.some((root) => isPathInsideRoot(candidatePath, root, platform))
}

/** 列出 Windows 上的系统敏感目录：系统目录、Program Files、ProgramData。 */
function windowsSensitiveRoots(env: NodeJS.ProcessEnv): string[] {
  const systemDrive = env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:'
  return [
    env.SystemRoot ?? env.SYSTEMROOT ?? `${systemDrive}\\Windows`,
    env.ProgramFiles ?? env.PROGRAMFILES,
    env['ProgramFiles(x86)'] ?? env.PROGRAMFILES_X86,
    env.ProgramData ?? env.PROGRAMDATA ?? `${systemDrive}\\ProgramData`,
  ].filter((value): value is string => !!value?.trim())
}

/** 判断写入或修改这个路径是否触及系统敏感区：系统目录、主目录下的隐藏文件、启动项目录；临时目录始终豁免。 */
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
    const relativeSegments = paths.relative(comparisonPath(home, platform), comparisonPath(abs, platform)).split(paths.sep)
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

/** 写入或修改系统敏感路径前向用户要确认；先把符号链接解开再判定，没有审批通道的宿主会直接拒绝。 */
export async function confirmSensitiveSystemMutation(
  ctx: SystemToolContext,
  resolvedPath: string,
  action: 'write' | 'edit'
): Promise<void> {
  if (!isSensitiveSystemMutationPath(await realPathForSafety(resolvedPath))) return

  // 审批统一走宿主注入的 ApprovalPort；本包不假设具体确认 UI 或运行模式。
  // autonomous 与后台 never-ask 的自动批准；execution 为空的宿主（web 桥/无人值守）得到设计式
  // deny——敏感路径写入按「无审批通道即拒绝」处理，不再对 ~/.ssh、/etc、LaunchAgents 等 fail-open。
  const verb = action === 'write' ? '写入/覆盖' : '修改'
  await ctx.approval.awaitConfirmation(
    `即将${verb}系统敏感路径：\n${resolvedPath}\n\n该路径位于系统目录或主目录的配置/凭证区（如 ~/.ssh、shell 启动文件、/etc 等），可能影响登录、凭证或系统行为。确认继续？`,
    ctx.abortSignal,
    {
      approvalRisk: 'high',
      riskScope: 'system-mutation:sensitive-path',
      operation: {
        key: createApprovalOperationKey('file-mutation', { path: resolvedPath }),
        label: '修改系统敏感文件',
        target: resolvedPath,
      },
    }
  )
}

/** 主目录下装凭证的目录：私钥、云服务凭证、密码库。 */
const CredentialHomeDirectories = ['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.docker', '.config/gcloud', 'Library/Keychains'] as const

/** 按文件名认出的凭证文件。 */
const CredentialFileNames = new Set(['.netrc', '.git-credentials', '.pypirc', '.npmrc', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'])

/** 按扩展名认出的密钥与证书。 */
const CredentialExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'])

/** 系统里装口令与私钥的路径。 */
const CredentialSystemPaths = ['/etc/shadow', '/private/etc/shadow', '/etc/sudoers', '/private/etc/sudoers', '/etc/ssl/private', '/private/etc/ssl/private'] as const

/** 判断一个路径是不是凭证文件：主目录下的凭证目录、常见凭证文件名、密钥与证书扩展名、系统口令文件。 */
export function isCredentialPath(resolvedPath: string, options: SensitiveSystemMutationPathOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  const paths = pathApi(platform)
  const abs = paths.resolve(resolvedPath)
  const name = paths.basename(abs)
  if (CredentialFileNames.has(name) || CredentialExtensions.has(paths.extname(name).toLowerCase())) return true
  if (platform !== 'win32' && isWithinAnyRoot(abs, CredentialSystemPaths, platform)) return true
  const home = options.homeDir ?? homedir()
  if (!home || !isPathInsideRoot(abs, home, platform)) return false
  const relative = paths.relative(comparisonPath(home, platform), comparisonPath(abs, platform)).split(paths.sep).join('/')
  return CredentialHomeDirectories.some((directory) => {
    const expected = platform === 'win32' || platform === 'darwin' ? directory.toLowerCase() : directory
    return relative === expected || relative.startsWith(`${expected}/`)
  })
}

/** 读或改凭证文件前向用户要确认；先把符号链接解开再判定，没有审批通道的宿主会直接拒绝。 */
export async function confirmCredentialAccess(ctx: SystemToolContext, resolvedPath: string, action: 'read' | 'write'): Promise<void> {
  const target = await realPathForSafety(resolvedPath)
  if (!isCredentialPath(target)) return
  const verb = action === 'read' ? '读取' : '改写'
  await ctx.approval.awaitConfirmation(
    `即将${verb}凭证文件：\n${resolvedPath}\n\n该文件可能包含私钥、令牌或口令，${action === 'read' ? '读取后内容会进入模型上下文' : '改坏会影响登录与访问'}。确认继续？`,
    ctx.abortSignal,
    {
      approvalRisk: 'high',
      riskScope: 'system-read:credential',
      operation: {
        key: createApprovalOperationKey('file-read', { path: resolvedPath, action }),
        label: action === 'read' ? '读取凭证文件' : '改写凭证文件',
        target: resolvedPath,
      },
    }
  )
}

/** 判定安全用的真实路径：解开符号链接；文件还不存在就解开最近的那层已存在的目录，再把剩下的段接回去。 */
export async function realPathForSafety(resolvedPath: string): Promise<string> {
  const trailing: string[] = []
  let current = resolvedPath
  for (;;) {
    const real = await realpath(current).catch(() => null)
    if (real) return isEmpty(trailing) ? real : path.join(real, ...trailing.reverse())
    const parent = path.dirname(current)
    if (parent === current) return resolvedPath
    trailing.push(path.basename(current))
    current = parent
  }
}
