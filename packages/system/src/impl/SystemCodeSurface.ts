/**
 * 系统空间的代码面：模型写 `import { read } from 'velar:system'`，调用落到这里。
 *
 * 这个文件里**没有一个字是给模型看的**。模型面是 `@AgentView` 从两个操作接口的源码生成的那份声明
 * （`baselines/code-surface/system.d.ts`）——说明、示例、字段解释全在那里，只有那一份。
 * 这里只剩两件事：**校验入参**、**把调用转给操作方法**。
 *
 * 和 `SystemTools.ts` 的分工：那边是工具时代的七个工具定义（说明 + schema + 权限 + 能力声明混在一起），
 * 两边共用同一批 schema 与同一批操作方法，所以不会各做各的。
 * 旧工具面留到 agent-lab 上打平为止——没有对照就没法证明这套换得对。
 */

import type { CapabilityOperationTable } from '@velaros-ai/code-surface/contracts'

import { SystemSpaceId } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'
import {
  editInputSchema,
  listTasksInputSchema,
  parseOperationInput,
  readInputSchema,
  refreshEnvironmentInputSchema,
  runInputSchema,
  sandboxInputSchema,
  viewInputSchema,
} from '../utils/operation-schemas.js'

import { systemExecutionOperations } from './SystemExecutionOperations.js'
import { systemFileOperations } from './SystemFileOperations.js'

/** 系统空间的代码面。 */
export interface SystemCodeSurfaceApi {
  /**
   * 操作表：`velar:system` 的每个方法一格，交给 `createCapabilityPort` 接成能力端口。
   *
   * 每次取都按当下的上下文解析器重新组；上下文（审批通道、取消信号、会话身份）由宿主每次调用时给，
   * **不能在这里缓存**——缓存一份就等于把上一次调用的审批通道借给下一次用。
   */
  readonly operations: CapabilityOperationTable
}

class SystemCodeSurface implements SystemCodeSurfaceApi {
  public constructor(
    private readonly resolveContext: (signal: Optional<AbortSignal>) => SystemToolContext | Promise<SystemToolContext>
  ) {}

  public get operations(): CapabilityOperationTable {
    const files = systemFileOperations
    const execution = systemExecutionOperations
    const context = (signal: Optional<AbortSignal>): Promise<SystemToolContext> =>
      Promise.resolve(this.resolveContext(signal))
    return {
      [SystemSpaceId]: {
        read: {
          parse: (input) => parseOperationInput(readInputSchema, input),
          run: async (input, signal) => files.read(input, await context(signal)),
        },
        view: {
          parse: (input) => parseOperationInput(viewInputSchema, input),
          run: async (input, signal) => files.view(input, await context(signal)),
        },
        edit: {
          parse: (input) => parseOperationInput(editInputSchema, input),
          run: async (input, signal) => files.edit(input, await context(signal)),
        },
        run: {
          parse: (input) => parseOperationInput(runInputSchema, input),
          run: async (input, signal) => execution.run(input, await context(signal)),
        },
        sandbox: {
          parse: (input) => parseOperationInput(sandboxInputSchema, input),
          run: async (input, signal) => execution.sandbox(input, await context(signal)),
        },
        refreshEnvironment: {
          parse: (input) => parseOperationInput(refreshEnvironmentInputSchema, input),
          run: async (_input, signal) => execution.refreshEnvironment(await context(signal)),
        },
        listTasks: {
          parse: (input) => parseOperationInput(listTasksInputSchema, input),
          run: async (input, signal) => execution.listTasks(input, await context(signal)),
        },
      },
    }
  }
}

/**
 * 装一个系统空间的代码面；上下文解析器由宿主给。
 *
 * 解析器每次调用都会被叫一次：审批通道与取消信号是**这一次调用**的，不是这一段程序的。
 */
export function createSystemCodeSurface(input: {
  resolveContext: (signal: Optional<AbortSignal>) => SystemToolContext | Promise<SystemToolContext>
}): SystemCodeSurfaceApi {
  return new SystemCodeSurface(input.resolveContext)
}
