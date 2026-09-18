/**
 * 注入面：宿主每次分发调用时给的上下文 `ProjectCallContext`，里面是宿主端口 `ProjectHostPort`（写作 `ctx.project`）与审批端口 `ApprovalPort`。
 *
 * 宿主端口在项目工具的空间端口（`@velaros-ai/velar/project` 的 `ProjectSpacePort`：项目根、内核、修改授权、代码查询）之上，
 * 再给三件共用能力要的东西：跑命令、后台任务、刷新 shell 环境（`velar:shell`），可选的演练沙箱端口 `ProjectSandboxPort`（`velar:sandbox`）
 * 与裁图缩图（`velar:images`）。空间把同一份上下文交给两件项目工具，它在结构上满足工具要的 `ProjectOperationContext`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { ImageAttachment, ImageResizeRequest, ImageResizeResult } from '@velaros-ai/velar/images'
import type { ProjectSpacePort } from '@velaros-ai/velar/project'
import type { RehearsalSandboxHostPort } from '@velaros-ai/velar/sandbox'
import type { ShellBackgroundTaskQueryOptions, ShellBackgroundTaskRecord, ShellCommandResult, ShellEnvironmentRefreshResult, ShellRunCommandOptions } from '@velaros-ai/velar/shell/contracts'

import type { ProjectSandboxRunOptions } from '../types/host.js'

/**
 * 宿主端口：项目空间在运行时能向宿主要什么，写作 `ctx.project`。宿主每次分发调用时给一份，绑定当前项目根、会话与这次调用的审批端口。
 * 两件项目工具要的四件（项目根、内核、修改授权、代码查询）来自 `ProjectSpacePort`；这里只列共用能力的项目端口要的，门禁从装配表出发核对。
 */
export interface ProjectHostPort extends ProjectSpacePort {
  /**
   * 在 options.cwd（绝对路径，空间已经核对过它在项目之内）跑一条 shell 命令，结果原样交给空间。
   * allowDangerous 为真表示这条命令被判为危险、用户已经亲自确认过，宿主不必再问；options.background 为真时宿主把它登记成后台任务后立即返回，做不到就抛错拒绝。
   * options.shell 挑定用哪个 shell（不给就用宿主自己挑的默认 shell）：宿主必须在挑定的那个里执行，本机没有它就在执行之前拒绝并点名可用的有哪些，不许换默认 shell 照跑。
   * 命令自己失败（非零退出、超时）写进结果，不抛错；abortSignal 触发时尽快停下。
   */
  runCommand: (
    command: string,
    options?: ShellRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<ShellCommandResult>
  /** 查询以后台方式启动的命令任务，最新的在前；`velar:shell` 的 listTasks 经它答。宿主按会话隔离时只看得到本会话起的那些。 */
  listBackgroundTasks: (options?: ShellBackgroundTaskQueryOptions) => Promise<ShellBackgroundTaskRecord[]>
  /** 重新选定能用的 shell 并读取它的环境变量；`velar:shell` 的 refreshEnvironment 经它答。 */
  refreshShellEnvironment: () => Promise<ShellEnvironmentRefreshResult>
  /** 演练沙箱端口；宿主用系统能力实现（Desktop 用本地内核）。没接的宿主，项目空间里没有 `velar:sandbox`。 */
  sandbox?: ProjectSandboxPort
  /** 裁图缩图（可选）：`velar:images` 看超过上限的图、只看一块区域时用。宿主没有图像处理能力就不给，view 遇到这种图会明说做不了。 */
  resizeImage?: (request: ImageResizeRequest) => Promise<ImageResizeResult>
}

/**
 * 演练沙箱端口：公共沙箱端口 `RehearsalSandboxHostPort`（建镜像、看差量、落回、丢弃）加上在镜像里跑命令。镜像里跑的命令被宿主约束在镜像根之内。
 * 项目空间出不了项目边界，所以在镜像里跑命令也经这个端口，不走普通的 `runCommand`。
 */
export interface ProjectSandboxPort extends RehearsalSandboxHostPort {
  /** 在镜像根里跑一条命令，约束钉在镜像根，写到项目会失败；`shell` 的规矩同 `runCommand`；危险命令已由 `velar:sandbox` 向用户确认过，abortSignal 触发时尽快停下。 */
  runInSandbox: (options: ProjectSandboxRunOptions, abortSignal?: AbortSignal) => Promise<ShellCommandResult>
}

/**
 * 每次调用项目空间的能力时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时装好，生成声明时整个丢掉。
 */
export interface ProjectCallContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发；空间在排队与每一步之间核对，宿主的命令与查询也应随之停下。 */
  abortSignal: AbortSignal
  /** 宿主端口：项目根、内核、修改授权、命令、代码查询与演练沙箱都经它要。 */
  project: ProjectHostPort
  /** 审批端口（来自 agent 包）：危险命令、沙箱落回、提交改动要用户亲自确认时经它；无人值守的宿主给默认拒绝的端口。 */
  approval: ApprovalPort
  /** 本次调用所属会话；给了，后台任务就按会话登记与核对归属，项目工具的引用也按它签发。 */
  sessionId?: string
  /** 把一张图交给模型看（`velar:images` 的 view 用它）；宿主收着，在这次结果后面按顺序放出来。不给就用代码面自己的图片通道。 */
  attachImage?: (image: ImageAttachment) => void
}
