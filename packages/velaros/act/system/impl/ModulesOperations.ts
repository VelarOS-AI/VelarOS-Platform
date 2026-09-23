/**
 * 能力发现（`velaros:system` 的 modules 成员，模块身份 `velaros:modules`）的操作：`ModulesOperations` 与整个进程唯一的 `modulesOperations`。
 * 接口 `ModulesOperationsApi` 在本文件的类上方。三个操作只查取消，再交给调用上下文里已按本会话授权筛过的目录。
 */

import type { ModulesOperationContext } from '../contract/requires.js'
import type { SystemModuleDescribeInput, SystemModuleDescription, SystemModulePage, SystemModuleQuery } from '../types/modules.js'

/**
 * @AgentView
 * 能力发现：只列本会话真能 import 的模块。拿不准某个模块怎么用时 describe 它，把 declarations 或 template 用 output 交出来再看。
 */
export interface ModulesOperationsApi {
  /** @AgentView 分页列出模块，可按 space 只看系统成员或业务能力。
   * @OperationEffect none
   */
  list(input: Optional<SystemModuleQuery>, ctx: ModulesOperationContext): Promise<SystemModulePage>
  /** @AgentView 按关键词找模块：匹配模块名、简介与操作名。
   * @OperationEffect none
   */
  search(input: Optional<SystemModuleQuery>, ctx: ModulesOperationContext): Promise<SystemModulePage>
  /** @AgentView 读一个模块的合同：完整声明、用法示例与每个操作的说明。
   * @OperationEffect none
   */
  describe(input: SystemModuleDescribeInput, ctx: ModulesOperationContext): Promise<SystemModuleDescription>
}

export class ModulesOperations implements ModulesOperationsApi {
  public async list(input: Optional<SystemModuleQuery>, ctx: ModulesOperationContext): Promise<SystemModulePage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.catalog.list(input ?? {})
  }

  public async search(input: Optional<SystemModuleQuery>, ctx: ModulesOperationContext): Promise<SystemModulePage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.catalog.list(input ?? {})
  }

  public async describe(input: SystemModuleDescribeInput, ctx: ModulesOperationContext): Promise<SystemModuleDescription> {
    ctx.abortSignal.throwIfAborted()
    return ctx.catalog.describe(input.module, input.export)
  }
}

/** 整个进程只有一份的发现操作；装配时把本会话的目录塞进每次调用的上下文。 */
export const modulesOperations: ModulesOperationsApi = new ModulesOperations()
