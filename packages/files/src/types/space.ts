/**
 * 空间端口上流动的数据：要用户确认的请求、一批写入里的一项、裁图缩图的请求与结果，以及交给模型看的一张图。
 * 带 `Buffer` 与 agent 的确认选项，所以不在可移植文件里；公开签名用到它们，从根入口导出。
 */

import type { ToolConfirmationDecisionOptions } from '@velaros-ai/agent/contracts'
import type { ExpectedBytes } from '@velaros-ai/text-files/contracts'

import type { FileImageRegion } from './files.js'

/** 空间要操作方法先问用户的一件事：确认文案与审批选项。操作方法交给审批端口去问，被拒就不做。 */
export interface FileConfirmation {
  message: string
  options: ToolConfirmationDecisionOptions
}

/** 一批写入里的一项：往 target 写这些字节；给了 expected 就在落盘时核对磁盘上还是它，不是就不写。 */
export interface FileWrite {
  target: string
  bytes: Buffer
  expected?: ExpectedBytes
}

/** 请宿主裁一块、缩到长边不超过 longEdge；两件事都没要求时宿主可以原样返回。 */
export interface FileImageResizeRequest {
  data: Buffer
  mediaType: string
  region?: FileImageRegion
  longEdge: number
}

/** 宿主裁完、缩完的图，以及它实际的尺寸与格式。 */
export interface FileImageResizeResult {
  data: Buffer
  mediaType: string
  width: number
  height: number
}

/** 交给模型看的一张图：宿主经调用上下文收走，放到这次结果后面。 */
export interface FileAttachedImage {
  mediaType: string
  /** base64，已经在上限以内。 */
  data: string
  /** 放在图前面的一行说明。 */
  label: string
}
