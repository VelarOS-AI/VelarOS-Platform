// 宿主装配时要用的几件纯判定：执行上限、运行画像策略、进程级运行事实、能力类别表。
import type { AgentRuntimeCapabilityPorts, AppRuntimeFacts } from '../../contract/requires'
import type { RunProfileRuntimePolicy, ToolCategoryDefinition, ToolCategoryId } from '../../types/agent'
import type { AgentExecutionLimitOverrides, AgentExecutionLimits } from '../../types/loop'
import type { AgentRunProfileCatalogSnapshot } from '../../types/runner'
import { resolveCapabilityCategoryDefinitions } from '../../utils/capabilities'
import { resolveAgentExecutionLimits } from '../../utils/loop/execution-limits'
import { configureAppRuntimeFacts } from '../../utils/runner/app-runtime-facts'
import { describeRunProfiles, resolveRunProfilePolicyForRuntime } from '../../utils/runner/runtime-profiles'

/**
 * 宿主装配执行栈前后要用到的几件纯判定。
 *
 * 除了 `configureHostFacts` 会写进程级的运行事实（宿主启动时调一次），其余都是纯函数。
 */
export interface AgentRuntimeKitApi {
  /** 把宿主给的上限覆盖并进缺省执行上限；越界值按字段报错。 */
  resolveExecutionLimits(overrides?: AgentExecutionLimitOverrides): AgentExecutionLimits
  /** 解出这一轮按哪套运行画像策略跑。 */
  resolveRunProfilePolicy(input: {
  requested?: LooseOptional<unknown>
  contextWindow?: LooseOptional<number>
  model?: LooseOptional<string>
}): RunProfileRuntimePolicy
  /** 列出全部运行画像供界面选择。 */
  describeRunProfiles(): AgentRunProfileCatalogSnapshot
  /** 登记进程级的宿主运行事实（应用名、版本、平台），提示词段按它渲染。 */
  configureHostFacts(next: Partial<AppRuntimeFacts>): void
  /** 把能力包贡献的工具类别定义合成一张表。 */
  resolveCapabilityCategories(ports?: AgentRuntimeCapabilityPorts): Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>
}

/** 方法逐个转调 utils 里的纯函数；这里只负责把它们收成一件对外能力。 */
class AgentRuntimeKit implements AgentRuntimeKitApi {
  public resolveExecutionLimits(overrides?: AgentExecutionLimitOverrides): AgentExecutionLimits {
    return resolveAgentExecutionLimits(overrides)
  }

  public resolveRunProfilePolicy(input: {
  requested?: LooseOptional<unknown>
  contextWindow?: LooseOptional<number>
  model?: LooseOptional<string>
}): RunProfileRuntimePolicy {
    return resolveRunProfilePolicyForRuntime(input)
  }

  public describeRunProfiles(): AgentRunProfileCatalogSnapshot {
    return describeRunProfiles()
  }

  public configureHostFacts(next: Partial<AppRuntimeFacts>): void {
    return configureAppRuntimeFacts(next)
  }

  public resolveCapabilityCategories(ports?: AgentRuntimeCapabilityPorts): Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> {
    return resolveCapabilityCategoryDefinitions(ports)
  }
}

/** 宿主装配用的运行期判定面（进程内共用一份）。 */
export const agentRuntime: AgentRuntimeKitApi = new AgentRuntimeKit()
