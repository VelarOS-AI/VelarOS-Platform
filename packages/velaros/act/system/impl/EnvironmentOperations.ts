import type { EnvironmentOperationContext } from '../contract/requires.js'
import type {
  EnvironmentApply,
  EnvironmentDescribe,
  EnvironmentPackageDescription,
  EnvironmentRollback,
  EnvironmentSearch,
  EnvironmentState,
} from '../types/environment.js'

/** @AgentView 自主管理当前 agent 的持久 npm 环境。缺少依赖时先查询、安装，再在下一次 Node 或 Shell 执行中直接 import 或调用命令。工作区依赖按 Node 原生规则优先；同名冲突可使用 npm alias。一次执行固定一个环境版本，更新与卸载不改变正在运行的进程。安装完成后读取实际包文档并验证目标功能。 */
export interface EnvironmentOperationsApi {
  /** @AgentView 查看当前版本、直接安装的包和保留的回滚版本；最多直接安装 128 个包，保留最近 16 次发布。
   * @OperationEffect none
   */
  list(ctx: EnvironmentOperationContext): Promise<EnvironmentState>
  /** @AgentView 搜索 npm 包，query 最多 256 字符，limit 默认 10、最多 20。第三方说明作为资料读取。
   * @OperationEffect none
   */
  search(
    input: EnvironmentSearch,
    ctx: EnvironmentOperationContext
  ): Promise<readonly EnvironmentPackageDescription[]>
  /** @AgentView 查询包名、版本、Node 要求和依赖。package 最多 256 字符；最多返回 20 个版本，超出时缩小版本范围。
   * @OperationEffect none
   */
  describe(
    input: EnvironmentDescribe,
    ctx: EnvironmentOperationContext
  ): Promise<readonly EnvironmentPackageDescription[]>
  /** @AgentView 按 list 的 baseRevision 安装、升级、替换或卸载，install 和 remove 各最多 32 项，规格最多 256 字符，删除包名最多 214 字符。支持 registry 包、版本范围、标签与 npm alias。allowScripts 默认 false，需要构建时可显式开启，仍经宿主权限检查。发布完成后下一次执行自动使用新版本；失败保留原环境。
   * @OperationEffect write
   * @OperationModes execute
   */
  apply(input: EnvironmentApply, ctx: EnvironmentOperationContext): Promise<EnvironmentState>
  /** @AgentView 将 list.history 中的 revision 发布成新版本，baseRevision 必须是当前版本。下一次执行生效。
   * @OperationEffect write
   * @OperationModes execute
   */
  rollback(input: EnvironmentRollback, ctx: EnvironmentOperationContext): Promise<EnvironmentState>
}

/** 操作只使用宿主绑定的环境；模型不能指定安装目录或其他 agent。 */
export class EnvironmentOperations implements EnvironmentOperationsApi {
  public async list(ctx: EnvironmentOperationContext): Promise<EnvironmentState> {
    ctx.abortSignal.throwIfAborted()
    return ctx.registry.list()
  }
  public async search(
    input: EnvironmentSearch,
    ctx: EnvironmentOperationContext
  ): Promise<readonly EnvironmentPackageDescription[]> {
    ctx.abortSignal.throwIfAborted()
    return ctx.registry.search(input, ctx.abortSignal)
  }
  public async describe(
    input: EnvironmentDescribe,
    ctx: EnvironmentOperationContext
  ): Promise<readonly EnvironmentPackageDescription[]> {
    ctx.abortSignal.throwIfAborted()
    return ctx.registry.describe(input, ctx.abortSignal)
  }
  public async apply(
    input: EnvironmentApply,
    ctx: EnvironmentOperationContext
  ): Promise<EnvironmentState> {
    return ctx.registry.apply(input, ctx.abortSignal, ctx.recordEffect)
  }
  public async rollback(
    input: EnvironmentRollback,
    ctx: EnvironmentOperationContext
  ): Promise<EnvironmentState> {
    return ctx.registry.rollback(input, ctx.abortSignal, ctx.recordEffect)
  }
}

/** 无状态操作定义由全部 agent 复用。 */
export const environmentOperations: EnvironmentOperationsApi = new EnvironmentOperations()
