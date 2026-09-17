/**
 * 文件安全：判断路径是否在根目录内、是否属于系统敏感区、是否是凭证文件，并造出写敏感路径、碰凭证文件之前要用户确认的请求。
 */

import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'

import { agentToolContracts } from '@velaros-ai/agent/tool-contract'
import { isNotNull, isNull } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import type { FileConfirmation } from '@velaros-ai/files'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { createPlatform, currentPlatform } from '@velaros-ai/platform'

import type { SensitiveSystemMutationPathOptions } from '../types/paths.js'

/** 按平台取 posix 或 win32 的路径工具。 */
function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

/** 按平台取跨平台兼容层：路径文本在不在根里、区不区分大小写由它回答（当前进程的那份直接用现成的）。 */
function platformTextRules(platform: NodeJS.Platform): PlatformCompatibilityApi {
  return platform === currentPlatform.getPlatform() ? currentPlatform : createPlatform({ platform })
}

/** 这个平台的路径文本区不区分大小写：Windows 与 macOS 的卷缺省不区分。 */
function comparesCaseSensitively(platform: NodeJS.Platform): boolean {
  return !(platform === 'win32' || platform === 'darwin')
}

/** 把路径解析成可比较的形式：Windows 和 macOS 的卷默认不区分大小写，统一小写比较；解开符号链接后的真实路径经它就是文件的身份键。 */
export function comparisonPath(value: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(value)
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
}

/** 判断一个路径是否在某个根目录之内（含根目录本身）：交给 platform 的路径文本判定，Windows 与 macOS 上不区分大小写；根是 `/`、`C:\` 这种也对。 */
export function isPathInsideRoot(
  candidatePath: string,
  rootPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platformTextRules(platform).isPathTextInside(pathApi(platform).resolve(candidatePath), rootPath)
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
  '/Applications',
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
  } else if (isWithinAnyRoot(abs, SensitiveSystemRootPrefixes, platform) || paths.dirname(abs) === '/') return true // 直接放在根目录下的文件也算系统级

  const home = options.homeDir ?? homedir()
  const homeRelative = home ? platformTextRules(platform).relativePathTextInside(abs, home) : null
  if (isNotNull(homeRelative)) {
    const relativeSegments = homeRelative.split('/')
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
    } else if (platform === 'darwin') {
      // macOS 上比较前已经统一小写，这里也用小写常量，登录项目录才拦得住。
      const [first = '', second = ''] = relativeSegments.map((segment) => segment.toLowerCase())
      if (first === 'library' && (second === 'launchagents' || second === 'launchdaemons')) return true
    }
  }
  return false
}


/**
 * 写系统敏感路径前要用户确认的那件事；不是敏感路径返回 null。传进来的必须是解开符号链接后的真实路径。
 *
 * 只造请求、不自己问：问不问、被拒怎么办由调用方（系统空间的文件端口交给 `velar:files`）决定。
 * 临时目录本身也要解开符号链接（macOS 的 /var 是 /private/var 的链接），不然临时文件会被误当成系统敏感路径。
 */
export async function sensitiveMutationConfirmation(target: string): Promise<Nullable<FileConfirmation>> {
  if (!isSensitiveSystemMutationPath(target, { tempDir: await resolveRealPath(tmpdir()) })) return null
  return {
    message: `即将写入/覆盖系统敏感路径：\n${target}\n\n该路径位于系统目录或主目录的配置/凭证区（如 ~/.ssh、shell 启动文件、/etc 等），可能影响登录、凭证或系统行为。确认继续？`,
    options: {
      approvalRisk: 'high',
      riskScope: 'system-mutation:sensitive-path',
      operation: {
        key: agentToolContracts.createApprovalOperationKey('file-mutation', { path: target }),
        label: '修改系统敏感文件',
        target,
      },
    },
  }
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
  // 目录那一半按大小写不敏感比较，文件名这一半也要：macOS 与 Windows 上 ID_RSA 和 id_rsa 是同一个文件。
  const comparableName = platform === 'win32' || platform === 'darwin' ? name.toLowerCase() : name
  if (CredentialFileNames.has(comparableName) || CredentialExtensions.has(paths.extname(name).toLowerCase())) return true
  if (platform !== 'win32' && isWithinAnyRoot(abs, CredentialSystemPaths, platform)) return true
  const home = options.homeDir ?? homedir()
  const homeRelative = home ? platformTextRules(platform).relativePathTextInside(abs, home) : null
  if (isNull(homeRelative)) return false
  const caseSensitive = comparesCaseSensitively(platform)
  const relative = caseSensitive ? homeRelative : homeRelative.toLowerCase()
  return CredentialHomeDirectories.some((directory) => {
    const expected = caseSensitive ? directory : directory.toLowerCase()
    return relative === expected || relative.startsWith(`${expected}/`)
  })
}

/** 读或改凭证文件前要用户确认的那件事；不是凭证文件返回 null。传进来的必须是解开符号链接后的真实路径。 */
export function credentialConfirmation(target: string, action: 'read' | 'write'): Nullable<FileConfirmation> {
  if (!isCredentialPath(target)) return null
  const verb = action === 'read' ? '读取' : '改写'
  return {
    message: `即将${verb}凭证文件：\n${target}\n\n该文件可能包含私钥、令牌或口令，${action === 'read' ? '读取后内容可能进入模型上下文' : '改坏会影响登录与访问'}。确认继续？`,
    options: {
      approvalRisk: 'high',
      riskScope: 'system-read:credential',
      operation: {
        key: agentToolContracts.createApprovalOperationKey('file-read', { path: target, action }),
        label: action === 'read' ? '读取凭证文件' : '改写凭证文件',
        target,
      },
    },
  }
}
