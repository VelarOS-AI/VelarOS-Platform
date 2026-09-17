/**
 * 系统空间的代码面：模型写 `import { read } from 'velar:system'`，调用落到这里。
 *
 * 这个文件里**没有一个字是给模型看的**。模型面是 `@AgentView` 从两个操作接口的源码生成的那份声明
 * （`baselines/code-surface/system.d.ts`）——说明、示例、字段解释全在那里，只有那一份。
 * 这里只剩一件事：**把调用转给操作方法**。入参合不合法由操作方法自己拦，那是它自己的职责
 * （它本来就要拦路径不存在、文件太大、编码认不出）；在这一层再盖一份校验只会变成第二个主人，而且换个入口就漏。
 */

import type { CapabilityOperationTable } from '@velaros-ai/code-surface/contracts'

import { SystemSpaceId } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'

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
        read: async (input, { signal }) => files.read(input, await context(signal)),
        // 图不进返回值：交给代码面的图片通道，程序跑完之后跟在结果后面给模型看。
        view: async (input, { signal, attach }) => files.view(input, {
          ...(await context(signal)),
          attachImage: (image) => attach({ type: 'image-data', ...image }),
        }),
        edit: async (input, { signal }) => files.edit(input, await context(signal)),
        run: async (input, { signal }) => execution.run(input, await context(signal)),
        refreshEnvironment: async (_input, { signal }) => execution.refreshEnvironment(await context(signal)),
        listTasks: async (input, { signal }) => execution.listTasks(input, await context(signal)),
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
