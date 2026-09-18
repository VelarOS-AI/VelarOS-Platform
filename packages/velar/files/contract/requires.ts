/**
 * 注入面：`velar:files` 要空间塞进来的东西，以及本机实现（`./local` 入口）要宿主给的配置。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 空间端口 `FileSpacePort`：每个挂 `velar:files` 的空间给一份——路径怎么解析、怎么落盘，都由它说了算。本机实现是 `createLocalFilePort`。
 * - 调用上下文 `FileOperationContext`：宿主分发每一次调用时装好。
 * - 本机文件端口的配置 `LocalFilePortOptions`、本机全局搜索的配置 `LocalFileSearchOptions`：用到哪个时给。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { FileLocation } from '../types/files.js'
import type { FileWrite } from '../types/space.js'

/**
 * `velar:files` 的空间端口：作用域与落盘两件事。
 *
 * 本机文件的读写（系统空间）挂它：路径可以是本机任意位置、`~` 展开到家目录，写是逐个原子替换（本机实现 `createLocalFilePort`）。
 * 项目里的文件不走这里——项目有自己的一套（`velar:project`：读取治理、事务、校验器）。
 * 读字节、认编码、按行拆合、核版本、留原文与撤回，在操作类里只做一份。
 */
export interface FileSpacePort {
  /** 把模型给的路径定下来（已去掉首尾的特殊空白）：回执里给模型看的写法，与解开符号链接后真正要读写的绝对路径。越出这个空间允许的范围时拒绝（`PERMISSION`），不悄悄钳到根上。 */
  locate: (path: string) => Promise<FileLocation>
  /**
   * 把一批写入按给的顺序落盘：bytes 是字节就原子替换（缺失的上级目录一并建好），是 null 就删掉这个文件。
   * 某一项给了 `expected`，落盘时就核对磁盘上还是它（或者仍不存在），不是就那一项不做、抛 `VALIDATION`。
   * 做到一半出错时，已经落盘的在错误的 `context.applied` 里点名（target 列表）。
   */
  commit: (writes: readonly FileWrite[]) => Promise<void>
}

/** 每次调用 `velar:files` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时按当前空间装好，生成声明时整个丢掉。 */
export interface FileOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发。 */
  abortSignal: AbortSignal
  /** 这个空间的端口：作用域与落盘都经它。 */
  files: FileSpacePort
}

// ── 本机实现的配置 ──────────────────────────────────────────────

/** 本机文件端口的配置：路径怎么解析由宿主定。 */
export interface LocalFilePortOptions {
  /**
   * 把模型给的路径解析成绝对路径。系统空间的写法是 `~` 展开到家目录、相对路径相对工作目录——本机 shell 宿主的 `resolvePath` 就是这样一个。
   * 端口再解开符号链接，读写真正的目标；本机文件端口不设范围，哪儿都能读写。
   */
  resolvePath: (path: string) => string
}

/** 本机全局搜索的配置，全可缺省。 */
export interface LocalFileSearchOptions {
  /** 按哪个平台判定受保护的目录（macOS 的隐私目录）；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /** 家目录，判定受保护目录时用；缺省用当前用户的家目录。 */
  homeDir?: string
}
