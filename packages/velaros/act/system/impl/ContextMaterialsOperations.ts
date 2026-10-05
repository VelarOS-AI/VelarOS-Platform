/**
 * 整理会话读父快照（`velaros:context-materials`）的操作：`ContextMaterialsOperations` 与整个进程唯一的 `contextMaterialsOperations`。
 * 接口 `ContextMaterialsOperationsApi` 在本文件的类上方。三个操作只查取消，再交给调用上下文里本整理会话的快照材料；快照范围、读取额度与补丁都由它核对。
 */

import type { ContextContent } from '@velaros-ai/context'

import type { ContextMaterialsOperationContext } from '../contract/requires.js'
import type {
  ContextMaintenancePage,
  ContextMaterialsQuery,
  ContextMaterialsReadInput,
  ContextPatch,
  ContextPatchReceipt,
} from '../types/maintenance.js'

/**
 * @AgentView
 * 父会话快照的原文与整理补丁：runtime.modelTool 已提供用户原文和近期记录，可直接依据它们整理；有缺口时按已有引用 read，查更早的材料时 list，最后用 submit 交来补丁。
 * 可读本次整理请求原文和授权的父快照；读取额度用完后不能再读，直接交付已有结论。
 */
export interface ContextMaterialsOperationsApi {
  /** @AgentView 按工作材料分页列用户输入、回复、源码、结果、笔记和历史卷的元数据，不读正文。
   * @OperationEffect none
   * @OperationModes execute
   */
  list(
    input: ContextMaterialsQuery,
    ctx: ContextMaterialsOperationContext
  ): Promise<ContextMaintenancePage>
  /** @AgentView 按引用读取本次整理请求或父快照原文的一页，正文在 text。
   * @OperationEffect none
   * @OperationModes execute
   */
  read(
    input: ContextMaterialsReadInput,
    ctx: ContextMaterialsOperationContext
  ): Promise<ContextContent>
  /** @AgentView 交来整理补丁：先整份校验，不合格就报错（修正后再交），合格就受理；原生调用成功后宿主完成交付，文本协议继续声明完成。
   * @OperationEffect none
   * @OperationModes execute
   */
  submit(input: ContextPatch, ctx: ContextMaterialsOperationContext): Promise<ContextPatchReceipt>
}

export class ContextMaterialsOperations implements ContextMaterialsOperationsApi {
  public async list(
    input: ContextMaterialsQuery,
    ctx: ContextMaterialsOperationContext
  ): Promise<ContextMaintenancePage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.materials.list(input, ctx.abortSignal)
  }

  public async read(
    input: ContextMaterialsReadInput,
    ctx: ContextMaterialsOperationContext
  ): Promise<ContextContent> {
    ctx.abortSignal.throwIfAborted()
    return ctx.materials.read(input, ctx.abortSignal)
  }

  public async submit(
    input: ContextPatch,
    ctx: ContextMaterialsOperationContext
  ): Promise<ContextPatchReceipt> {
    ctx.abortSignal.throwIfAborted()
    return ctx.materials.submit(input, ctx.abortSignal)
  }
}

/** 整个进程只有一份的快照读取操作；装配时把本整理会话的材料端口塞进每次调用的上下文。 */
export const contextMaterialsOperations: ContextMaterialsOperationsApi =
  new ContextMaterialsOperations()
