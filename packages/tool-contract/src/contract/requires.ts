/**
 * 注入面：内核按名调一个工具之前，宿主得先给出这次调用的工具上下文。本包自己不认识任何空间的上下文，
 * 解析器由空间在挂载内核模块时塞进来；没有它就一个操作都不登记，工具说明仍可读但谁都调不动。
 * 这里的每个类型都必须从根入口导出。
 */

import type {
  ScopeRef,
} from '@velaros-ai/kernel/contracts'

/**
 * 按作用域给出这次调用的工具上下文。
 *
 * 谁给：挂载内核模块的那个空间（它知道自己的上下文长什么样）；什么时候给：每次按名调用工具、
 * 且入参已经过 schema 严格解析之后；必不必须：可以不给——不给时能力服务只登记零个操作。
 * 返回的上下文里的 `abortSignal` 会被换成内核给的那个，实现不必自己拼。
 */
export type ToolContextResolver<TContext> = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => TContext | Promise<TContext>
