import type { InteractionPort } from '../../contract/requires.js'

/**
 * 无 execution 会话通道宿主的默认端口：一切交互会话读写按**设计式空降级**处理。
 *
 * 用于 web 桥 / serve 等没有 execution 记录的执行层宿主，以及任何 execution 为 null 的
 * 构造路径。计划面返回空结构、任务/推荐/建议返回 null（而非旧的 `ctx.execution!` null
 * 崩溃事故式失败），让读取计划的工具与提示词组装在无会话宿主上安全降级、不抛 TypeError。
 */
class UnsupportedInteractionPort implements InteractionPort {
  /** 无会话宿主没有执行 id，用空串占位。 */
  public readonly executionId = ''

  /** 计划面降级为空数组。 */
  public getCurrentPlan(): [] {
    return []
  }

  /** 无会话宿主写不进计划，原样返回空数组。 */
  public updateCurrentPlan(): [] {
    return []
  }

  /** 无当前任务。 */
  public getCurrentTask(): null {
    return null
  }

  /** 无推荐动作。 */
  public getCurrentRecommendedAction(): null {
    return null
  }

  /** 无执行建议。 */
  public getCurrentExecutionAdvice(): null {
    return null
  }
}

/** 无 execution 会话通道宿主的默认端口实例。 */
export const defaultUnsupportedInteractionPort: InteractionPort = new UnsupportedInteractionPort()
