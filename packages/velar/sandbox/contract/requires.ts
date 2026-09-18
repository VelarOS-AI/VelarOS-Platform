/**
 * 注入面：宿主要实现的演练沙箱端口。系统空间的宿主（`SystemSpaceHost`）与项目空间的沙箱端口都扩展它，
 * 经它建镜像、看差量、落回、丢弃；本机的实现是 `@velaros-ai/system` 的本地内核。
 * 代码面的 `sandbox` 命名空间要的那一份是 `SandboxSurfacePort`，多出在镜像里跑命令与作用域两件事，每次调用的上下文是
 * `SandboxOperationContext`。这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type { SandboxApplyPolicy } from '../types/apply.js'
import type { SandboxApplyOptions, SandboxApplyResult, SandboxCommandOutcome, SandboxCreateOptions, SandboxDiff, SandboxDiffOptions, SandboxDiscardResult, SandboxRecord, SandboxRunOptions, SandboxSelection } from '../types/rehearsal-sandbox.js'

/** 宿主的演练沙箱：把一个目录镜像到临时区、看镜像相对创建时的变化、把变化落回源目录、丢弃镜像。镜像里的命令由空间各自的端口跑，不在这里。 */
export interface RehearsalSandboxHostPort {
  /** 建沙箱：镜像源目录（gitignore 忽略的目录按 ignored 处理），镜像里的仓库剪掉推送地址；超过上限（数量、文件数、字节）建不出。 */
  createSandbox: (options?: SandboxCreateOptions) => Promise<SandboxRecord>
  /** 看差量：三列相对路径与有界的文本差量；maxFiles 截新增、修改两列，textDiffs 为 false 时不附文本差量。 */
  diffSandbox: (options: SandboxDiffOptions) => Promise<SandboxDiff>
  /** 落回：只写源目录之内、要么全落要么报清落了哪些；给了 fingerprint 就先核对，镜像在确认之后又变过就整批不落；.git 的变化永远不落。 */
  applySandbox: (options: SandboxApplyOptions) => Promise<SandboxApplyResult>
  /** 丢弃：只删沙箱基目录之下的镜像；本来就不在时 removed 为 false。 */
  discardSandbox: (sandboxId: string) => Promise<SandboxDiscardResult>
}

/**
 * 代码面 `sandbox` 命名空间的宿主端口：公共沙箱端口，加上在镜像里跑命令和这个空间的两条作用域规则。
 *
 * **两个空间的差别全落在这里**，模型那边因此只有一套说明，不再挑「这是哪个空间的沙箱」：
 * 系统空间的实现让 `resolveSource` 收任意路径、不给就用默认工作目录，项目空间的实现把它钳在项目内、越界就拒绝；
 * `applyPolicy` 同理，各自给各自的风险分类与落回提醒。安全故事因此在端口里，不在提示词里。
 */
export interface SandboxSurfacePort extends RehearsalSandboxHostPort {
  /** 把模型给的 source 解析成要镜像的真实目录：不给就是宿主给的根；越出这个空间允许的范围时拒绝（PERMISSION），不悄悄钳到根上。 */
  resolveSource: (source?: string) => Promise<string>
  /** 在镜像根里跑一条命令，约束钉在镜像根，写到源目录会失败；命令自己失败写进回执不抛错，abortSignal 触发时尽快停下。 */
  runInSandbox: (options: SandboxRunOptions, abortSignal?: AbortSignal) => Promise<SandboxCommandOutcome>
  /** 这个空间落回时的政策，按被镜像的真实目录给：确认文案落到哪儿、最后一句提醒、风险分类、要特别点名的敏感路径。 */
  applyPolicy: (source: string) => SandboxApplyPolicy
  /**
   * 落回之前这个空间自己要核的那一关（可选）：拿到的是这次真要落的三列，排在**问用户之前**——
   * 注定落不下去的东西不该拿去打扰用户。项目空间在这里核对每条路径项目许不许写、再过一次项目的修改授权；
   * 不许就抛（`PERMISSION`），一个文件都不落。
   */
  reviewApply?: (selection: SandboxSelection) => Promise<void>
}

/** 每次调用 `sandbox` 命名空间时宿主给的上下文。它不是模型能填的入参：宿主在分发这次调用时按当前空间装好，代码面生成声明时整个丢掉。 */
export interface SandboxOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发；每个操作在调端口之前核对，宿主的镜像与命令也应随之停下。 */
  abortSignal: AbortSignal
  /** 这个空间的沙箱端口：作用域、镜像、命令、差量、落回都经它，操作类自己不碰文件系统。 */
  sandbox: SandboxSurfacePort
  /** 审批端口（来自 agent 包）：落回与镜像里的危险命令要用户亲自确认时经它；无人值守的宿主给默认拒绝的端口，于是这两件在那种宿主上一定失败。 */
  approval: ApprovalPort
}
