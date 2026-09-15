/**
 * 命令数据：执行前分类的结果、进程约束的策略与请求结果、受管进程的收尾结果、shell 的解析与自检结果、刷新后的 Windows 环境。
 * 只放数据；带行为的接口在 `interface/`。
 */

import type { CommandSpec } from './platform.js'
import type { SystemProcessConfinementEvidence, SystemProcessConfinementMode, SystemProcessOwnership, SystemShellDescriptor } from './system.js'

// ── 执行前分类 ──────────────────────────────────────────────────

/**
 * shell 命令的**执行前分类**：只读？要确认？该丢后台？
 *
 * 导览（§5.3b ④安全门）——这三个判定各自兜着一道闸，误判的代价互不相同，所以判据也不同：
 * - `isReadOnly` 决定**能否并行执行**（`isParallelCommandExecutionSafe`）。判成"只读"却其实会写，
 *   意味着多个写操作被并发放行。因此这里是 **白名单 + 整体否决**：命令名必须在
 *   `readOnlyCommands` 里，出现任何重定向/反引号/子 shell/后台符（`><`、`` ` ``、`$()`、`&`）
 *   或换行就**整条判非只读**——不做逐段拆解，因为 shell 的组合语法足够刁钻，
 *   "解析对了大部分"在安全判定里等于错。`git` 单独再查一次子命令白名单（`git push` 不是只读）。
 * - `isDangerous` 决定**是否强制确认**。这里是黑名单（递归删除 `rm -r`、丢弃未提交改动的 Git 调用、
 *   `mkfs`、`dd if=`、`shutdown`、`sudo`…），漏判的后果是少弹一次确认框，不是自动放行——真正的授权门在宿主的 ApprovalPort。
 * - `shouldStartInBackground` 是**体验判定**不是安全判定（识别 dev server 之类长驻进程），
 *   误判只会让命令跑在前台或后台，别把它和上面两条混为一谈。
 *
 * 新增命令时的方向：往 `readOnlyCommands` 里加要能证明**任何参数组合下都不写**；
 * 往危险黑名单里加则可以宽松（多弹一次确认无害）。
 */
export interface SystemCommandExecutionPlan {
  isReadOnly: boolean
  shouldRequestConfirmation: boolean
  shouldStartInBackground: boolean
  reason: Nullable<string>
  isDangerous: boolean
  dangerousReason: Nullable<string>
  ports: number[]
}

// ── 进程约束 ────────────────────────────────────────────────────

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

// ── 受管子进程 ──────────────────────────────────────────────────

export interface SystemProcessCompletion {
  exitCode: Nullable<number>
  signal: Nullable<string>
  timedOut: boolean
  aborted: boolean
  spawnError: Nullable<Error>
  cleanupIncomplete: boolean
}

// ── shell 选择与自检 ──────────────────────────────────────

export interface ResolvedSystemShell extends SystemShellDescriptor {
  env: NodeJS.ProcessEnv
}

export interface SystemShellProbeResult {
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

// ── 命令执行器与命令分类内部的数据 ──────────────────────────────

/** 准备好的一条命令：可以直接 spawn 的规格和环境，外加约束、归属、shell 三份证据。 */
export interface PreparedSystemCommand {
  spec: CommandSpec
  env: NodeJS.ProcessEnv
  evidence: SystemProcessConfinementEvidence
  ownership: SystemProcessOwnership
  shell: SystemShellDescriptor
}

/** 一个交互式任务的控制台输出缓冲：只留末尾一段，produced 记住这路输出从头到现在一共产生过多少字符。 */
export interface SystemConsoleOutputBuffer {
  buffer: string
  produced: number
}

/** 命令位置上的一次调用：规范化后的命令名与它在本段内的实参。 */
export interface ShellInvocation {
  name: string
  args: string[]
}
