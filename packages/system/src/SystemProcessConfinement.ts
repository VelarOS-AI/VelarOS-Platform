import { existsSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

import { isEmpty, isFalse, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  SystemProcessConfinementBackend,
  SystemProcessConfinementEnforcement,
  SystemProcessConfinementEvidence,
  SystemProcessConfinementMode,
} from './SystemContracts.js'
import type { CommandSpec } from './SystemPlatformCompatibility.js'

export interface SystemProcessConfinementPolicy {
  mode: SystemProcessConfinementMode
  /** `workspace-write` 的主要写边界；其余模式仍携带它，便于一次解析后统一审计。 */
  workspaceRoot: string
  /** 宿主额外批准的写根（例如受管日志目录）；模型不得直接控制。 */
  writeRoots?: readonly string[]
  /** false 时同时切断网络；缺省只治理文件副作用。 */
  network?: boolean
}

export interface SystemProcessConfinementRequest {
  spec: CommandSpec
  policy: SystemProcessConfinementPolicy
}

export interface SystemProcessConfinementResult {
  spec: CommandSpec
  evidence: SystemProcessConfinementEvidence
  /** 仅供本机调试和测试；不得当作授权来源。 */
  profile?: string
}

/** 宿主可注入 Windows restricted-token、容器或更强的同机约束实现。 */
export interface SystemProcessConfinementProvider {
  confine(request: SystemProcessConfinementRequest): SystemProcessConfinementResult
}

export interface SystemProcessConfinementBuildOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  provider?: SystemProcessConfinementProvider
  sandboxExecPath?: string
  sandboxExecAvailable?: boolean
  bubblewrapPath?: string
  bubblewrapAvailable?: boolean
  tempDir?: string
}

const DefaultSandboxExecPath = '/usr/bin/sandbox-exec'
const DefaultBubblewrapPath = 'bwrap'

function confinementUnavailable(
  policy: SystemProcessConfinementPolicy,
  platform: NodeJS.Platform,
  reason: string
): never {
  throw new AppError(
    'SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE',
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

function uniqueRoots(policy: SystemProcessConfinementPolicy, tempDir?: string): string[] {
  if (policy.mode !== 'workspace-write') return []
  const roots = [
    assertAbsoluteRoot(policy.workspaceRoot, 'workspaceRoot'),
    ...(policy.writeRoots ?? []).map((root) => assertAbsoluteRoot(root, 'writeRoots')),
  ]
  if (tempDir?.trim()) roots.push(assertAbsoluteRoot(tempDir, 'tempDir'))
  return [...new Set(roots)]
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Nullable<string> {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return existsSync(command) ? command : null
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(entry, command)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function quoteSeatbeltString(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

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
  if (policy.mode !== 'danger-full-access' && result.evidence.enforcement === 'none') {
    throw new AppError('INVARIANT', '进程约束提供方不得把受约束请求降级为裸进程。', undefined, {
      source: 'system-process-confinement',
      mode: policy.mode,
      backend: result.evidence.backend,
    })
  }
  return result
}

function enforcedEvidence(
  mode: SystemProcessConfinementMode,
  backend: SystemProcessConfinementBackend,
  writableRoots: string[],
  enforcement: SystemProcessConfinementEnforcement = 'full'
): SystemProcessConfinementEvidence {
  return { mode, backend, enforcement, reason: 'enforced', writableRoots }
}

/**
 * 把精确 argv 包在同机进程约束后面。受约束模式永不静默回退；Windows 等没有内建后端的
 * 平台必须注入 host provider，否则明确拒绝执行。
 */
export function buildSystemProcessConfinementSpawnSpec(
  request: SystemProcessConfinementRequest,
  options: SystemProcessConfinementBuildOptions = {}
): SystemProcessConfinementResult {
  const policy: SystemProcessConfinementPolicy = {
    ...request.policy,
    workspaceRoot: assertAbsoluteRoot(request.policy.workspaceRoot, 'workspaceRoot'),
  }
  if (policy.mode === 'danger-full-access') return {
    spec: { file: request.spec.file, args: [...request.spec.args] },
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
