/**
 * 代码面那扇门上流动的数据：一次「模型交来一段程序」的入参、交回给模型的回执、门替每个会话记着的状态。
 */

import type { CodeCapabilityPort, CodeSurfaceEventSink } from '../contract/requires.js'

import type { CodeAttachment, CodeProgramRequest, CodeSurfaceOutcome, MountedCapabilityModule } from './code-surface.js'

/** 门跑一次要的东西：哪个会话、模型交来的程序、这个空间挂的能力与它们的端口。 */
export interface CodeGateRunInput {
  /** 会话身份：导入过的模块、上一份程序按它记。 */
  sessionId: string
  /** 模型交来的程序：整份 source，或者在上一份上改的 edits，外加 blobs。 */
  program: CodeProgramRequest
  /** 这个空间挂的能力：常驻的声明一直给检查器，其余 import 了才给。 */
  modules: readonly MountedCapabilityModule[]
  /** 这个空间的能力端口：程序发出的调用经它办，审批与危险判定在它里面。 */
  capabilities: CodeCapabilityPort
  /** 墙钟上限（毫秒）；不给用缺省，仍受对外上限钳制。 */
  timeoutMs?: number
  /** 取消信号：用户停下这一轮时触发。 */
  signal?: AbortSignal
  /** 界面要实时看见的事（调用起止、日志）；模型那边不走这条路。 */
  events?: CodeSurfaceEventSink
}

/** 门交回的东西：给模型读的一段文字、跟在后面的图，以及原样的结果（宿主要记账、渲染界面时用）。 */
export interface CodeGateReply {
  /** 给模型读的回执：诊断、要补的声明，或者程序的结果。 */
  text: string
  /** 程序交给模型看的图，按交出的顺序。 */
  images: readonly CodeAttachment[]
  /** 会话给出的原样结果。 */
  outcome: CodeSurfaceOutcome
}

/** 门替一个会话记着的东西。 */
export interface CodeGateSessionState {
  /** 模型 import 过、完整声明已经给过它的模块（命名空间）；检查程序时一并加载。 */
  imported: Set<string>
  /** 给过声明、后来退租的模块：再用到时静默装回去，不再让模型白跑一轮。 */
  retired: Set<string>
  /** 上一份程序的正文：模型传 edits 时在它上面改。 */
  previousSource?: string
}
