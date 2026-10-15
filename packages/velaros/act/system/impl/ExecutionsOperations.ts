import type { ExecutionsOperationContext } from '../contract/requires.js'
import type {
  ExecutionRead,
  ExecutionSnapshot,
  ExecutionTarget,
  ExecutionWait,
} from '../types/executions.js'

/** @AgentView 检查当前任务已受理的执行，或定向请求停止。沿用 executionId，不重新运行源码。 */
export interface ExecutionsOperationsApi {
  /** @AgentView 按游标读取状态与有界 stdout/stderr；运行时合并输出变化，避免逐行查询。终态后仍可取剩余输出。
   * @OperationEffect none
   */
  read(input: ExecutionRead, ctx: ExecutionsOperationContext): Promise<ExecutionSnapshot>
  /** @AgentView 等待已有执行结束并读取有界输出；waitMs 为整数毫秒 1..60000，默认 60000。到期返回当时状态，目标继续运行；终态或 unknown 立即返回。取消仅结束等待，不能等待自身。无需反复 read 或创建定时器程序。
   * @OperationEffect none
   */
  wait(input: ExecutionWait, ctx: ExecutionsOperationContext): Promise<ExecutionSnapshot>
  /** @AgentView 请求停止当前任务的一个执行，返回当时状态；继续 read 确认终态及清理。不能停止调用者自身。
   * @OperationEffect write
   * @OperationModes execute
   */
  stop(input: ExecutionTarget, ctx: ExecutionsOperationContext): Promise<ExecutionSnapshot>
}

/** 执行归属和取消由 Runtime 校验，模块只承接当前调用身份。 */
export class ExecutionsOperations implements ExecutionsOperationsApi {
  public async read(
    input: ExecutionRead,
    ctx: ExecutionsOperationContext
  ): Promise<ExecutionSnapshot> {
    ctx.abortSignal.throwIfAborted()
    return ctx.executions.read(input, ctx.abortSignal)
  }
  public async wait(
    input: ExecutionWait,
    ctx: ExecutionsOperationContext
  ): Promise<ExecutionSnapshot> {
    ctx.abortSignal.throwIfAborted()
    return ctx.executions.wait(input, ctx.executionId, ctx.abortSignal)
  }
  public async stop(
    input: ExecutionTarget,
    ctx: ExecutionsOperationContext
  ): Promise<ExecutionSnapshot> {
    ctx.abortSignal.throwIfAborted()
    const result = await ctx.executions.stop(input, ctx.executionId, ctx.abortSignal)
    ctx.recordEffect(result.stopRequested ? 'committed' : 'none')
    return result
  }
}

/** 真实运行身份经唯一 Kernel 调用链传入。 */
export const executionsOperations: ExecutionsOperationsApi = new ExecutionsOperations()
