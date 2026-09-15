/**
 * 进程约束：生成 macOS Seatbelt 与 Linux bubblewrap 的沙箱启动规格。
 */

import { existsSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

import { isEmpty, isFalse, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SystemProcessConfinementPolicy, SystemProcessConfinementRequest, SystemProcessConfinementResult } from '../contract/commands.js'
import type { CommandSpec } from '../contract/platform.js'
import type { SystemProcessConfinementBackend, SystemProcessConfinementEnforcement, SystemProcessConfinementEvidence, SystemProcessConfinementMode } from '../contract/system.js'
import { SystemErrorCodes } from '../contract/system.js'
import type { SystemProcessConfinementBuildOptions } from '../interface/internal.js'

const DefaultSandboxExecPath = '/usr/bin/sandbox-exec'

const DefaultBubblewrapPath = 'bwrap'

/** 抛出「受约束模式在当前宿主不可用」错误，拒绝退回裸进程执行。 */
function confinementUnavailable(
  policy: SystemProcessConfinementPolicy,
  platform: NodeJS.Platform,
  reason: string
): never {
  throw new AppError(
    SystemErrorCodes.processConfinementUnavailable,
    `进程约束模式“${policy.mode}”在当前 ${platform} 宿主不可用，已拒绝以裸进程继续执行。`,
    undefined,
    {
      source: 'system-process-confinement',
      mode: policy.mode,
      platform,
      reason,
    }
  )
}

/** 校验约束用的根目录必须是绝对路径，返回解析符号链接后的真实路径；Windows 路径原样返回。 */
function assertAbsoluteRoot(path: string, label: string): string {
  const normalized = path.trim()
  const windowsAbsolute = /^[A-Za-z]:[\\/]/u.test(normalized) || /^\\\\/u.test(normalized)
  if (!normalized || (!isAbsolute(normalized) && !windowsAbsolute)) {
    throw new AppError('VALIDATION', `${label} 必须是绝对路径。`, undefined, {
      source: 'system-process-confinement',
      path,
    })
  }
  // 跨平台宿主/测试可能在非 Windows 进程中组装 Windows 契约；不要用 POSIX resolve 改坏盘符。
  if (windowsAbsolute && !isAbsolute(normalized)) return normalized
  const absolute = resolve(normalized)
  return existsSync(absolute) ? realpathSync(absolute) : absolute
}

/** 列出 workspace-write 模式下允许写入的根目录（工作区、额外写根、临时目录）并去重；其他模式返回空列表。 */
function uniqueRoots(policy: SystemProcessConfinementPolicy, tempDir?: string): string[] {
  if (policy.mode !== 'workspace-write') return []
  const roots = [
    assertAbsoluteRoot(policy.workspaceRoot, 'workspaceRoot'),
    ...(policy.writeRoots ?? []).map((root) => assertAbsoluteRoot(root, 'writeRoots')),
  ]
  if (tempDir?.trim()) roots.push(assertAbsoluteRoot(tempDir, 'tempDir'))
  return [...new Set(roots)]
}

/** 在 PATH 里查找可执行文件，找不到返回 null；给的是路径时只检查它是否存在。 */
function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Nullable<string> {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return existsSync(command) ? command : null
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(entry, command)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 把字符串转义成 Seatbelt 配置里带引号的字面量。 */
function quoteSeatbeltString(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** 生成 macOS Seatbelt 沙箱配置：默认禁止写文件，只放行批准的写根，按需切断网络。 */
export function buildSystemSeatbeltProfile(
  policy: SystemProcessConfinementPolicy,
  options: Pick<SystemProcessConfinementBuildOptions, 'tempDir'> = {}
): string {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${quoteSeatbeltString('/dev/null')}))`,
  ]
  const roots = uniqueRoots(policy, options.tempDir)
  if (!isEmpty(roots)) {
    forms.push(
      `(allow file-write* ${roots
        .map((root) => `(subpath ${quoteSeatbeltString(root)})`)
        .join(' ')})`
    )
  }
  if (isFalse(policy.network)) forms.push('(deny network*)')
  return forms.join(' ')
}

/** 生成 Linux bubblewrap 启动规格：根目录只读挂载，只把批准的写根挂成可写，按需切断网络。 */
export function buildSystemBubblewrapSpec(
  spec: CommandSpec,
  policy: SystemProcessConfinementPolicy,
  options: Pick<SystemProcessConfinementBuildOptions, 'bubblewrapPath' | 'tempDir'> = {}
): CommandSpec {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
  ]
  if (isFalse(policy.network)) args.push('--unshare-net')
  for (const root of uniqueRoots(policy, options.tempDir)) {
    if (existsSync(root)) args.push('--bind', root, root)
  }
  args.push('--', spec.file, ...spec.args)
  return { file: options.bubblewrapPath ?? DefaultBubblewrapPath, args }
}

/** 校验宿主注入的约束后端返回的结果与请求一致，受约束模式确实做到了完整约束。 */
function assertProviderResult(
  result: SystemProcessConfinementResult,
  policy: SystemProcessConfinementPolicy
): SystemProcessConfinementResult {
  if (result.evidence.mode !== policy.mode) {
    throw new AppError('INVARIANT', '进程约束提供方返回了与请求不一致的 mode。', undefined, {
      source: 'system-process-confinement',
      requestedMode: policy.mode,
      actualMode: result.evidence.mode,
    })
  }
  if (policy.mode !== 'danger-full-access' && result.evidence.enforcement !== 'full') {
    throw new AppError('INVARIANT', '当前请求需要完整进程约束，提供方返回的隔离能力不足。', undefined, {
      source: 'system-process-confinement',
      mode: policy.mode,
      backend: result.evidence.backend,
      enforcement: result.evidence.enforcement,
    })
  }
  return result
}

/** 生成一份「约束已生效」的证据记录。 */
function enforcedEvidence(
  mode: SystemProcessConfinementMode,
  backend: SystemProcessConfinementBackend,
  writableRoots: string[],
  enforcement: SystemProcessConfinementEnforcement = 'full'
): SystemProcessConfinementEvidence {
  return { mode, backend, enforcement, reason: 'enforced', writableRoots }
}

/** 把一条命令包进同机进程约束，返回实际启动规格与约束证据；受约束模式没有可用后端时拒绝执行，不退回裸进程。 */
export function buildSystemProcessConfinementSpawnSpec(
  request: SystemProcessConfinementRequest,
  options: SystemProcessConfinementBuildOptions = {}
): SystemProcessConfinementResult {
  const policy: SystemProcessConfinementPolicy = {
    ...request.policy,
    workspaceRoot: assertAbsoluteRoot(request.policy.workspaceRoot, 'workspaceRoot'),
  }
  if (policy.mode === 'danger-full-access') return {
      spec: { ...request.spec, args: [...request.spec.args] },
    evidence: {
      mode: policy.mode,
      enforcement: 'none',
      backend: 'none',
      reason: 'explicit-danger-full-access',
      writableRoots: [],
    },
  }

  if (options.provider)
    return assertProviderResult(options.provider.confine({ spec: request.spec, policy }), policy)

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'darwin') {
    const configuredPath = options.sandboxExecPath ?? DefaultSandboxExecPath
    const executable = isFalse(options.sandboxExecAvailable)
      ? null
      : isTrue(options.sandboxExecAvailable)
        ? configuredPath
        : resolveExecutable(configuredPath, env)
    if (!executable) confinementUnavailable(policy, platform, 'sandbox-exec-unavailable')
    const profile = buildSystemSeatbeltProfile(policy, options)
    return {
      spec: {
        file: executable,
        args: ['-p', profile, '--', request.spec.file, ...request.spec.args],
      },
      evidence: enforcedEvidence(policy.mode, 'seatbelt', uniqueRoots(policy, options.tempDir)),
      profile,
    }
  }

  if (platform === 'linux') {
    const configuredPath = options.bubblewrapPath ?? DefaultBubblewrapPath
    const executable = isFalse(options.bubblewrapAvailable)
      ? null
      : isTrue(options.bubblewrapAvailable)
        ? configuredPath
        : resolveExecutable(configuredPath, env)
    if (!executable) confinementUnavailable(policy, platform, 'bubblewrap-unavailable')
    return {
      spec: buildSystemBubblewrapSpec(request.spec, policy, {
        ...options,
        bubblewrapPath: executable,
      }),
      evidence: enforcedEvidence(policy.mode, 'bubblewrap', uniqueRoots(policy, options.tempDir)),
    }
  }

  return confinementUnavailable(policy, platform, 'host-provider-required')
}
