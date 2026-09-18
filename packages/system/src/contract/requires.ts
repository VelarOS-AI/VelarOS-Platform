/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 系统空间的宿主 `SystemSpaceHost`：装系统空间时必须给，本机实现就是本地内核 `LocalSystemKernel`。
 * - 调用上下文 `SystemCallContext`：必须。宿主每次分发调用时给，里面是审批端口、会话与交图通道。
 * - 本地内核配置 `LocalSystemKernelOptions`：用本地内核时必须，创建时给。
 * - 进程约束后端 `SystemProcessConfinementProvider`：可选，放在本地内核配置里，没有内置约束后端的平台（Windows）靠它。
 * - 环境变量：可选，全部登记在 `contract/constants.ts` 的 `SystemEnvironmentVariables`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { ImageAttachment } from '@velaros-ai/velar/images'
import type { RehearsalSandboxHostPort } from '@velaros-ai/velar/sandbox'
import type { SandboxRecord } from '@velaros-ai/velar/sandbox/contracts'
import type { ShellProcessConfinementMode, ShellSpacePort } from '@velaros-ai/velar/shell'

import type { SystemProcessConfinementRequest, SystemProcessConfinementResult } from '../types/commands.js'

// ── 系统空间 ────────────────────────────────────────────────────

/**
 * 系统空间要宿主给的本机能力：解析路径、跑命令与管后台任务的四件事、演练沙箱的四件事，加上列出登记着的沙箱。
 * 系统空间拿它装出 `velar:files`、`velar:shell`、`velar:sandbox`、`velar:images` 四个端口；本机实现是本地内核。
 */
export interface SystemSpaceHost extends RehearsalSandboxHostPort, Pick<ShellSpacePort, 'runCommand' | 'listBackgroundTasks' | 'refreshShellEnvironment' | 'terminateBackgroundTask'> {
  /**
   * 把用户给的路径解析成绝对路径：`~` 与 `~/…` 展开到宿主的家目录，相对路径相对宿主的默认工作目录；不给路径就返回默认工作目录。
   * 文件的路径、命令的 cwd、沙箱的源目录都经它解析，审批看到的目标和实际操作的目标因此一致。
   */
  resolvePath(path?: string): string
  /** 登记着的演练沙箱：在镜像里跑命令时按沙箱 id 找到镜像根。 */
  listSandboxes(): SandboxRecord[]
}

/**
 * 每次调用拿到的上下文，宿主分发调用时给。
 *
 * 审批通道始终存在；无人值守宿主应提供默认拒绝端口，需要审批的操作在那种宿主上一定被拒。
 */
export interface SystemCallContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，操作和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 本次调用所属会话。给了，后台任务就按会话登记与核对归属，别的会话列不到也停不了；不给就不隔离。 */
  sessionId?: string
  /** 审批端口（来自 agent 包）：写敏感路径、碰凭证文件、跑危险命令、落回沙箱前经它向用户确认。 */
  approval: ApprovalPort
  /** 把一张图交给模型看；宿主收着，在这次结果后面按顺序放出来。不给就用不了 view。 */
  attachImage?: (image: ImageAttachment) => void
}

// ── 本地内核 ────────────────────────────────────────────────────

/** 创建本地内核时宿主给的配置。 */
export interface LocalSystemKernelOptions {
  /** 工作目录：命令的默认 cwd，相对路径都相对它。 */
  cwd: string
  /** 家目录，`~` 展开到这里；缺省用当前用户的家目录。 */
  homeDir?: string
  /** 按哪个平台跑命令、读系统信息；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /**
   * 同机命令的进程约束策略。缺省保持兼容的 `danger-full-access`，但仍在结果中明确报告
   * `enforcement:none`；受约束模式没有可用后端时会失败关闭。
   */
  processConfinement?: {
    /** 约束模式：只读、只许写工作区，或不约束。 */
    mode: ShellProcessConfinementMode
    /** 工作区根，只许写工作区时的写边界；缺省是 cwd。 */
    workspaceRoot?: string
    /** 宿主额外批准的写根，例如受管日志目录；模型不能直接控制。 */
    writeRoots?: readonly string[]
    /** 为 false 时同时切断网络；缺省只管文件写入。 */
    network?: boolean
    /** 约束后端；平台没有内置后端时靠它，缺了就在受约束模式下失败。 */
    provider?: SystemProcessConfinementProvider
  }
}

/** 进程约束后端：宿主可以注入 Windows restricted-token、容器或更强的同机约束实现。 */
export interface SystemProcessConfinementProvider {
  /** 把一条命令的启动规格包进约束里，返回约束后的启动规格和如实的约束证据；做不到时抛错，不许返回未约束的规格。 */
  confine(request: SystemProcessConfinementRequest): SystemProcessConfinementResult
}
