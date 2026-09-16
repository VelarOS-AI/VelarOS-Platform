import type { InteractionPort } from '../../contract/requires.js'

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
