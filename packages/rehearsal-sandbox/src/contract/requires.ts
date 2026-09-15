/**
 * 注入面：宿主要实现的演练沙箱端口。system 空间的宿主端口（`SystemToolSystemApi`）与 project 空间的沙箱端口都扩展它，
 * 两个工具经它建镜像、看差量、落回、丢弃；本机的实现是 `@velaros-ai/system` 的本地内核。这里的每个接口都必须从根入口导出。
 */

import type { SandboxApplyOptions, SandboxApplyResult, SandboxCreateOptions, SandboxDiff, SandboxDiffOptions, SandboxDiscardResult, SandboxRecord } from '../types/rehearsal-sandbox.js'

/** 宿主的演练沙箱：把一个目录镜像到临时区、看镜像相对创建时的变化、把变化落回源目录、丢弃镜像。镜像里的命令由空间各自的执行端口跑，不在这里。 */
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
