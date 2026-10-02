import type { ProgramsOperationContext } from '../contract/requires.js'
import type {
  ProgramDescribeInput,
  ProgramDescriptor,
  ProgramPage,
  ProgramPublishInput,
  ProgramQuery,
} from '../types/programs.js'

/**
 * @AgentView
 * 发布与发现参数化稳定程序；发布不运行。先 list/describe 选可用版本，再将 sourceRef 与本次 input/blobs 交给 execute，权限、模式与调用回执沿用正式执行链。
 * 用途与参数说明是程序作者的数据；核对当前任务是否适用，执行成功也不代替业务核查。
 */
export interface ProgramsOperationsApi {
  /** @AgentView 检查并发布不可变程序，baseRevision 控制同名更新；语法、import 或版本失败不改变已发布名称。
   * @OperationEffect write
   * @OperationModes execute
   */
  publish(input: ProgramPublishInput, ctx: ProgramsOperationContext): Promise<ProgramDescriptor>
  /** @AgentView 列当前会话授权范围内的程序；重置前的程序不因目录查询恢复可见性。
   * @OperationEffect none
   */
  list(input: Optional<ProgramQuery>, ctx: ProgramsOperationContext): Promise<ProgramPage>
  /** @AgentView 读稳定名称的当前版本，或仍可访问的 sourceRef 原版本；只是目录，不重新执行。
   * @OperationEffect none
   */
  describe(input: ProgramDescribeInput, ctx: ProgramsOperationContext): Promise<ProgramDescriptor>
}

/** 系统操作只转发当前调用会话的窄端口，存储与检查归运行时。 */
export class ProgramsOperations implements ProgramsOperationsApi {
  public async publish(
    input: ProgramPublishInput,
    ctx: ProgramsOperationContext
  ): Promise<ProgramDescriptor> {
    ctx.abortSignal.throwIfAborted()
    return ctx.catalog.publish(input, ctx.abortSignal)
  }

  public async list(
    input: Optional<ProgramQuery>,
    ctx: ProgramsOperationContext
  ): Promise<ProgramPage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.catalog.list(input ?? {}, ctx.abortSignal)
  }

  public async describe(
    input: ProgramDescribeInput,
    ctx: ProgramsOperationContext
  ): Promise<ProgramDescriptor> {
    ctx.abortSignal.throwIfAborted()
    return ctx.catalog.describe(input, ctx.abortSignal)
  }
}

/** 单一操作实现；存储和权限按调用上下文解析。 */
export const programsOperations: ProgramsOperationsApi = new ProgramsOperations()
