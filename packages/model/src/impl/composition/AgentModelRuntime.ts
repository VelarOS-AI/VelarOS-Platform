import type {
  AgentProvider,
  ModelAdapterRegistryPort,
  ResolvedAgentModelRuntime,
} from '../../types/adapters'
import {
  parseModelRuntimeContext,
  parseModelSelection,
  parseProviderSelection,
} from '../../utils/scripts/selection'

import type { AgentModelResolverApi } from './AgentModelResolver'

/**
 * Agent 侧唯一的模型入口。
 *
 * 导览（§5.3b ⑤跨层接缝）——Agent 与 Core 不该知道 provider 长什么样，但它们必须能发起一次模型调用。
 * 本类的两个方法各收一个 `unknown`，在这里一次性解析成 Model 域的具体契约；
 * 解析之后（§1.8）包内不再复检。所以**新增 selection 轴必须在解析函数里加分支**，
 * 只改类型不会让新字段真的过河。
 *
 * **方向铁律**：解析只做收窄与拒绝，不做业务回退——provider 不可用由
 * `AgentModelResolver` 判并给可读诊断（§2.7），解析这一层抛的一律是形状错。
 */
export interface AgentModelRuntimeApi {
  /** 把一份 provider selection 解析成一个语言模型工厂；不查可用性。 */
  createAgentProvider(selection: unknown): AgentProvider
  /** 把一份完整 selection 与运行时上下文解析开，再交给解析器要一个可用运行时。 */
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown,
    signal?: AbortSignal
  ): Promise<ResolvedAgentModelRuntime>
}

class AgentModelRuntime implements AgentModelRuntimeApi {
  constructor(
    private readonly modelAdapterRegistry: ModelAdapterRegistryPort,
    private readonly modelResolver: AgentModelResolverApi
  ) {}

  public createAgentProvider(selection: unknown): AgentProvider {
    const config = parseProviderSelection(selection)
    return this.modelAdapterRegistry.createLanguageModelFactory(config)
  }

  public async resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown,
    signal?: AbortSignal
  ): Promise<ResolvedAgentModelRuntime> {
    return this.modelResolver.resolve(
      parseModelSelection(selection),
      parseModelRuntimeContext(runtimeContext),
      signal
    )
  }
}

export { AgentModelRuntime }
