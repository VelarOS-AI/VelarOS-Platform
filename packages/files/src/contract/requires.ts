/**
 * 注入面：`velar:files` 要空间塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 空间端口 `FileSpacePort`：每个挂 `velar:files` 的空间给一份——路径怎么解析、哪些要问人、怎么落盘，都由它说了算。
 * - 调用上下文 `FileOperationContext`：宿主分发每一次调用时装好。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type { FileLocation } from '../types/files.js'
import type { FileAttachedImage, FileConfirmation, FileImageResizeRequest, FileImageResizeResult, FileWrite } from '../types/space.js'

/**
 * `velar:files` 的空间端口：作用域、策略、落盘三件事，外加一件可选的宿主能力。
 *
 * **空间之间的差别全落在这里**，模型那边因此只有一套说明：系统空间的路径可以是本机任意位置、`~` 展开到家目录，
 * 凭证文件与系统敏感路径先问用户，写是逐个原子替换；项目空间把路径钳在项目内，写合成一个事务。
 * 读字节、认编码、核版本、压图这些所有空间都一样的事，在操作类里只做一份。
 */
export interface FileSpacePort {
  /** 把模型给的路径定下来（已去掉首尾的特殊空白）：回执里给模型看的写法，与解开符号链接后真正要读写的绝对路径。越出这个空间允许的范围时拒绝（`PERMISSION`），不悄悄钳到根上。 */
  locate: (path: string) => Promise<FileLocation>
  /** 读 target 之前：这个空间不许读就抛（`PERMISSION`，说明原因）；要先问用户就把确认请求交回来（操作方法去问），不用问给空数组。 */
  reviewRead: (target: string) => Promise<readonly FileConfirmation[]>
  /** 写 target 之前：同上。一批写入里每个文件各问一次，第一次被拒整批就不写了。 */
  reviewWrite: (target: string) => Promise<readonly FileConfirmation[]>
  /**
   * 把一批写入按给的顺序落盘，缺失的上级目录一并建好。某一项给了 `expected`，落盘时就核对磁盘上还是它，
   * 不是就那一项不写、抛 `VALIDATION`。写到一半出错时，已经落盘的在错误的 `context.applied` 里点名（target 列表）；
   * 能整批回滚的空间回滚后不点名。
   */
  commit: (writes: readonly FileWrite[]) => Promise<void>
  /**
   * 把图裁一块、缩到长边不超过 `longEdge`，返回新图与它实际的尺寸。**只在需要时才会被调**：
   * 图在上限以内、又没要求裁的，原样交给模型。宿主做不了图像处理就不给，view 遇到超限的图会明说。
   */
  resizeImage?: (request: FileImageResizeRequest) => Promise<FileImageResizeResult>
}

/** 每次调用 `velar:files` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时按当前空间装好，生成声明时整个丢掉。 */
export interface FileOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发。 */
  abortSignal: AbortSignal
  /** 这个空间的端口：作用域、策略、落盘都经它。 */
  files: FileSpacePort
  /** 审批端口（来自 agent 包）：空间要求先问的事经它问用户；无人值守的宿主给默认拒绝的端口。 */
  approval: ApprovalPort
  /**
   * 把一张图交给模型看。图不进返回值——返回值是给程序的，程序看不了像素；
   * 宿主收着，在这次结果后面按顺序放出来。不给就用不了 view。
   */
  attachImage?: (image: FileAttachedImage) => void
}
