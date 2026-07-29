// 域：提示词 / 轮次上下文装配（prompt-context-assembly）的**宿主边界端口**
// （宪章 §12.2 窄端口注入，仿 agent/runner/host-ports 模板）。
//
// 运行上下文装配本体 host 无关，只认端口不认实现：流经的工具上下文、代码会话读取子面、
// 工具上下文等能力都由宿主注入。具体产品域通过 capability ports 贡献上下文，
// runtime 不持有任何具体产品能力的专用辅助器。
import type { ToolCategoryId } from '@velaros-ai/core/types'

import type {
  PromptStateCodingSession,
  PromptStateExecutionApi,
  PromptStateToolContext,
} from '../PromptState'

/**
 * 运行上下文读取的代码会话子面。
 *
 * 叠在提示词构建器约束的 {@link PromptStateCodingSession} 之上，补齐轮次载荷所需的
 * active 工具类别读取。Desktop 真实 `ToolCodingSessionApi`（更宽）结构上满足。
 */
export interface RunContextCodingSession extends PromptStateCodingSession {
  getActiveToolCategories(): ToolCategoryId[]
}

/**
 * 运行上下文装配流经的工具上下文端口。
 *
 * 结构上是 Desktop `ToolContext` 的**装配实际读取/透传子集**，叠在提示词构建器的
 * {@link PromptStateToolContext} 约束之上（`execution` 由非空交互会话端口 `interaction`
 * 派生，故此处放宽为交互面 + 补齐轮次载荷读取的 `listTools`）。
 * Desktop 真实 ToolContext（更宽）结构上满足。
 */
export type RunContextToolContext = Omit<
  PromptStateToolContext,
  'codingSession' | 'execution'
> & {
  codingSession: RunContextCodingSession
  interaction: PromptStateExecutionApi
  dispatchSubAgent?: LooseOptional<unknown>
  listTools(): ReadonlyArray<{ name: string }>
}
