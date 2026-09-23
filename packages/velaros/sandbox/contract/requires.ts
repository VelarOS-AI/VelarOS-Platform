/**
 * 注入面：宿主要实现的演练沙箱端口，经它建镜像、看差量、落回、丢弃；本机实现是 `createLocalSandboxHost`（`./local` 入口），
 * 它的配置 `LocalSandboxHostOptions` 也在这里。代码面的 `sandbox` 命名空间要的那一份是 `SandboxSurfacePort`，
 * 多出在镜像里跑命令与作用域两件事，每次调用的上下文是 `SandboxOperationContext`。这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/kernel'
import type { ShellProcessConfinementProvider } from '@velaros-ai/velaros/shell'

import type {
  SandboxApplyOptions,
  SandboxApplyResult,
  SandboxCommandOutcome,
  SandboxCreateOptions,
  SandboxDiff,
  SandboxDiffOptions,
  SandboxDiscardResult,
  SandboxRecord,
  SandboxRunOptions,
} from '../types/rehearsal-sandbox.js'

/**
 * 宿主的演练沙箱：把一个目录镜像到临时区、在镜像里跑命令、看镜像相对创建时的变化、把变化落回源目录、丢弃镜像。
 * 本机实现是 `createLocalSandboxHost`；空间给 `velaros:sandbox` 装端口时把它原样接上，自己只补作用域（`SandboxSurfacePort` 的 `resolveSource`）。
 */
export interface RehearsalSandboxHostPort {
  /** 建沙箱：镜像源目录（gitignore 忽略的目录按 ignored 处理），镜像里的仓库剪掉推送地址；超过上限（数量、文件数、字节）建不出。 */
  createSandbox: (options?: SandboxCreateOptions) => Promise<SandboxRecord>
  /** 看差量：三列相对路径永远完整，外加新增与修改的文本文件的统一差量；paths 只给这些文件附差量，textDiffs 为 false 时一个都不附。 */
  diffSandbox: (options: SandboxDiffOptions) => Promise<SandboxDiff>
  /** 落回：只写源目录之内、要么全落要么报清落了哪些；给了 fingerprint 就先核对，镜像在看过差量之后又变过就整批不落；.git 的变化永远不落。 */
  applySandbox: (options: SandboxApplyOptions) => Promise<SandboxApplyResult>
  /** 丢弃：只删沙箱基目录之下的镜像；本来就不在时 removed 为 false。 */
  discardSandbox: (sandboxId: string) => Promise<SandboxDiscardResult>
  /** 在镜像根里跑一条命令，约束钉在镜像根，写到源目录会失败；命令自己失败写进回执不抛错，abortSignal 触发时尽快停下。 */
  runInSandbox: (
    options: SandboxRunOptions,
    abortSignal?: AbortSignal
  ) => Promise<SandboxCommandOutcome>
}

/**
 * 代码面 `sandbox` 命名空间的宿主端口：宿主的演练沙箱，加上这个空间的作用域规则。
 *
 * **两个空间的差别全落在这里**，模型那边因此只有一套说明，不再挑「这是哪个空间的沙箱」：
 * 系统空间的实现让 `resolveSource` 收任意路径、不给就用默认工作目录，项目空间的实现把它钳在项目内、越界就拒绝。
 */
export interface SandboxSurfacePort extends RehearsalSandboxHostPort {
  /** 把模型给的 source 解析成要镜像的真实目录：不给就是宿主给的根；越出这个空间允许的范围时拒绝（PERMISSION），不悄悄钳到根上。 */
  resolveSource: (source?: string) => Promise<string>
}

/** 每次调用 `sandbox` 命名空间时宿主给的上下文。它不是模型能填的入参：宿主在分发这次调用时按当前空间装好，代码面生成声明时整个丢掉。 */
export interface SandboxOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发；每个操作在调端口之前核对，宿主的镜像与命令也应随之停下。 */
  abortSignal: AbortSignal
  /** 这个空间的沙箱端口：作用域、镜像、命令、差量、落回都经它，操作类自己不碰文件系统。 */
  sandbox: SandboxSurfacePort
  /** 审批端口（来自 agent 包）：镜像里的危险命令要用户亲自确认时经它；无人值守的宿主给默认拒绝的端口，于是危险命令在那种宿主上一定失败。 */
  approval: ApprovalPort
}

/** 创建本机演练沙箱宿主时给的配置，全可缺省。 */
export interface LocalSandboxHostOptions {
  /** 镜像里的命令按哪个平台跑；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /** 约束后端；平台没有内置后端（Windows）时靠它，缺了就建不出沙箱。 */
  confinementProvider?: ShellProcessConfinementProvider
  /** 沙箱基目录；缺省是临时区下的 velaros-sandbox。 */
  baseDir?: string
}
