import type { ToolExecutionPlanUpdate } from '../types/agent'
import type {
  ExecutionTaskExecutionAdvice,
  ExecutionTaskPlanStep,
  ExecutionTaskRecommendedAction,
  ExecutionTaskRecord,
} from '../types/execution'

/**
 * 交互会话端口，是审批端口 ApprovalPort 的姊妹件。
 *
 * 把执行会话的**非审批交互面**抽象成一个通道：工具只管读写当前会话的计划、任务、推荐动作、
 * 执行建议，这些状态从哪来（Desktop 宿主复用执行记录，还是无会话宿主的设计式空降级）由宿主
 * 注入的实现决定。端口形状是执行交互面的结构化子集，故 Desktop 宿主可直接以执行本体作实现、
 * 行为逐字节不变，无执行记录的宿主得到 {@link defaultUnsupportedInteractionPort}。
 *
 * 与审批面正交：本端口只承载「会话读写」，不表达审批。等待用户输入与动作卡结果在本仓由审批端口
 * 的确认决策承载（提问卡 `ask_user` 即经此路），故不在此端口重复。
 */
export interface InteractionPort {
  /** 当前交互会话（execution）标识；无会话宿主为空串。 */
  executionId: string
  /** 读取当前会话可见的执行计划；无会话时返回空计划。 */
  getCurrentPlan: () => ExecutionTaskPlanStep[]
  /** 更新并返回当前会话可见的执行计划；无会话时为 no-op、返回空计划。 */
  updateCurrentPlan: (input: ToolExecutionPlanUpdate) => ExecutionTaskPlanStep[]
  /** 读取当前任务记录；无会话时返回 null。 */
  getCurrentTask: () => Nullable<ExecutionTaskRecord>
  /** 读取系统对下一步的推荐动作；无会话或无推荐时返回 null。 */
  getCurrentRecommendedAction: () => Nullable<ExecutionTaskRecommendedAction>
  /** 读取当前执行建议；无会话或无建议时返回 null。 */
  getCurrentExecutionAdvice: () => Nullable<ExecutionTaskExecutionAdvice>
}

/**
 * 无 execution 会话通道宿主的默认端口：一切交互会话读写按**设计式空降级**处理。
 *
 * 用于 web 桥 / serve 等没有 execution 记录的执行层宿主，以及任何 execution 为 null 的
 * 构造路径。计划面返回空结构、任务/推荐/建议返回 null（而非旧的 `ctx.execution!` null
 * 崩溃事故式失败），让读取计划的工具与提示词组装在无会话宿主上安全降级、不抛 TypeError。
 */
export const defaultUnsupportedInteractionPort: InteractionPort = {
  executionId: '',
  getCurrentPlan: () => [],
  updateCurrentPlan: () => [],
  getCurrentTask: () => null,
  getCurrentRecommendedAction: () => null,
  getCurrentExecutionAdvice: () => null,
}
