import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type { ToolCategoryId } from '../../types/agent.js'
import type { CapabilityRunPlan, PlanCapabilityRunInput, ResolveCapabilityPageFaultsInput, ToolCategory, ToolPageFault } from '../../types/loop.js'
import { planCapabilityRun, resolveCapabilityPageFaults, resolveCapabilityProtectedTools, resolveCapabilityToolCategoriesForExposure } from '../../utils/loop/capability-run-planner'

/**
 * 一轮请求的能力规划件：这轮换入哪些工具类别、暴露哪些工具、哪些工具缺页了。
 *
 * 规则本身是纯函数（`utils/loop/capability-run-planner.ts`），这里只把它们收成一个可注入的规划件，
 * 让宿主换掉「工具空间怎么换页、预算不够先丢谁」时不必改回合装配本身。无状态：引导进度由入参
 * `bootstrapState` 带进来，换页记账走入参回调。
 */
export interface CapabilityRunPlannerApi {
  /**
   * 排这一轮的能力计划：跑工具空间引导、合并类别、按宿主 residency 与运行档位预算定这轮暴露哪些工具，
   * 并结出缺页清单与下一轮的引导状态。纯计算，不落任何状态；工具不够用不抛错，改成缺页交给恢复计划。
   */
  plan(input: PlanCapabilityRunInput): CapabilityRunPlan
  /**
   * 把「当前可见的类别」与「运行时能恢复出来的类别」并成这轮参与暴露的类别表；同名类别按工具名去重合并。
   * 给还没走完整 `plan` 的调用点单独用。
   */
  resolveToolCategoriesForExposure<TTool extends { name: string }>(input: {
    visibleEnabledToolCategories: Array<ToolCategory<TTool>>
    runtimeToolCategories: Array<ToolCategory<TTool>>
    enabledToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    capabilityPorts?: AgentRuntimeCapabilityPorts
  }): Array<ToolCategory<TTool>>
  /** 只要这轮的受保护工具名单：预算吃紧时这些工具不许被挤掉。按名换入的工具一律在内。 */
  resolveProtectedTools(input: {
    enabledToolCategories: Array<ToolCategory<{ name: string }>>
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolNames: readonly string[]
  }): string[]
  /**
   * 结出这轮的工具缺页：强制工具没能暴露算一条，被预算挤掉的「按名换入」工具各算一条，最后按工具名与原因去重。
   * 只报告不恢复，怎么退由恢复计划决定。
   */
  resolvePageFaults(input: ResolveCapabilityPageFaultsInput): ToolPageFault[]
}

class CapabilityRunPlanner implements CapabilityRunPlannerApi {
  public plan(input: PlanCapabilityRunInput): CapabilityRunPlan {
    return planCapabilityRun(input)
  }

  public resolveToolCategoriesForExposure<TTool extends { name: string }>(input: {
    visibleEnabledToolCategories: Array<ToolCategory<TTool>>
    runtimeToolCategories: Array<ToolCategory<TTool>>
    enabledToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    capabilityPorts?: AgentRuntimeCapabilityPorts
  }): Array<ToolCategory<TTool>> {
    return resolveCapabilityToolCategoriesForExposure(input)
  }

  public resolveProtectedTools(input: {
    enabledToolCategories: Array<ToolCategory<{ name: string }>>
    budgetOverrideToolCategoryIds: readonly ToolCategoryId[]
    budgetOverrideToolNames: readonly string[]
  }): string[] {
    return resolveCapabilityProtectedTools(input)
  }

  public resolvePageFaults(input: ResolveCapabilityPageFaultsInput): ToolPageFault[] {
    return resolveCapabilityPageFaults(input)
  }
}

/** 能力规划件的共享实例：无状态，全仓共用一份即可。 */
export const capabilityRunPlanner: CapabilityRunPlannerApi = new CapabilityRunPlanner()

export { CapabilityRunPlanner }
