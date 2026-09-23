/**
 * 命令数据：进程约束的策略与请求结果（宿主注入约束后端时要用，从根入口导出），以及命令执行、shell 选择、进程约束实现自己的工作类型
 * （受管进程的收尾结果、自检结果、刷新后的环境、准备好的命令、控制台缓冲、带回调的选项）。只放类型；ResolvedShell 随登录环境 API 导出，其余工作类型在包内使用。
 */

import type { ShellCommandSpecOptions } from '@velaros-ai/core/platform'
import type { CommandSpec } from '@velaros-ai/core/platform/contracts'

import type { ShellProcessConfinementProvider } from '../contract/requires.js'

import type {
  ShellDescriptor,
  ShellProcessConfinementEvidence,
  ShellProcessConfinementMode,
  ShellProcessOwnership,
} from './shell-command.js'

export interface ShellProcessConfinementPolicy {
  mode: ShellProcessConfinementMode
  /** `workspace-write` 的主要写边界；其余模式仍携带它，便于一次解析后统一审计。 */
  workspaceRoot: string
  /** 宿主额外批准的写根（例如受管日志目录）；模型不得直接控制。 */
  writeRoots?: readonly string[]
  /** false 时同时切断网络；缺省只治理文件副作用。 */
  network?: boolean
}

export interface ShellProcessConfinementRequest {
  spec: CommandSpec
  policy: ShellProcessConfinementPolicy
}

export interface ShellProcessConfinementResult {
  spec: CommandSpec
  evidence: ShellProcessConfinementEvidence
  /** 仅供本机调试和测试；不得当作授权来源。 */
  profile?: string
}

// ── 本机环境数据与实现工作类型 ─────────────────────────────────────

export interface ShellProcessCompletion {
  exitCode: Nullable<number>
  signal: Nullable<string>
  timedOut: boolean
  aborted: boolean
  spawnError: Nullable<Error>
  cleanupIncomplete: boolean
}

export interface ResolvedShell extends ShellDescriptor {
  env: NodeJS.ProcessEnv
}

/** 同一加载代次的环境与可选的已自检 Shell，只在本机环境缓存内使用。 */
export interface ShellEnvironmentSnapshot {
  env: NodeJS.ProcessEnv
  shell?: ResolvedShell
}

export interface ShellProbeResult {
  ready: boolean
  version?: string
  reason?: string
}

export interface RefreshedWindowsEnvironment {
  env: NodeJS.ProcessEnv
  revision: string
  refreshed: boolean
  reason?: string
}

/** 准备好的一条命令：可以直接 spawn 的规格和环境，外加约束、归属、shell 三份证据。 */
export interface PreparedShellCommand {
  spec: CommandSpec
  env: NodeJS.ProcessEnv
  evidence: ShellProcessConfinementEvidence
  ownership: ShellProcessOwnership
  shell: ShellDescriptor
}

/** 一个交互式任务的控制台输出缓冲：只留末尾一段，produced 记住这路输出从头到现在一共产生过多少字符。 */
export interface ShellConsoleBuffer {
  buffer: string
  produced: number
}

/** 选 shell 时的选项；平台、环境变量、指定的 shell 路径与种类见继承的 `ShellCommandSpecOptions`。 */
export interface ResolveShellOptions extends ShellCommandSpecOptions {
  /** 取消 shell 自检时中止对应进程。 */
  signal?: AbortSignal
  /** 判断文件存在的方式；缺省用真实文件系统，测试时可以换成假的。 */
  isFile?: (path: string) => boolean
  /** 每个候选试跑的超时毫秒数，默认 2500。 */
  timeoutMs?: number
  /** 自定义就绪自检；缺省让 shell 打印带中文的标记和版本。 */
  probe?: (shell: ResolvedShell, timeoutMs: number) => Promise<ShellProbeResult>
}

/** 找 Windows 原生进程宿主、把命令包进宿主时的选项。 */
export interface ShellProcessHostOptions {
  /** 按哪个平台判断；只有 Windows 才用原生宿主。 */
  platform?: NodeJS.Platform
  /** 读 VELAROS_PROCESS_HOST 用的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 显式指定原生宿主的路径，优先于环境变量和默认位置。 */
  hostPath?: string
  /** 子进程要跟随的父进程 pid；缺省是当前进程。 */
  parentPid?: number
  /** 判断文件存在的方式；缺省用真实文件系统，测试时可以换。 */
  isFile?: (path: string) => boolean
}

/** 给命令加进程约束时的选项。 */
export interface ShellProcessConfinementBuildOptions {
  /** 按哪个平台选约束后端：macOS 用 sandbox-exec，Linux 用 bubblewrap。 */
  platform?: NodeJS.Platform
  /** 找约束工具可执行文件用的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 宿主注入的约束后端，给了就优先用它。 */
  provider?: ShellProcessConfinementProvider
  /** sandbox-exec 的路径，缺省是系统自带的那个。 */
  sandboxExecPath?: string
  /** sandbox-exec 是否可用；缺省按路径探测。 */
  sandboxExecAvailable?: boolean
  /** bubblewrap 的路径，缺省在 PATH 里找。 */
  bubblewrapPath?: string
  /** bubblewrap 是否可用；缺省按路径探测。 */
  bubblewrapAvailable?: boolean
  /** 临时目录，约束里一律允许写它。 */
  tempDir?: string
}
