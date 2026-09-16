/**
 * 定义工具时的入参类型：说明、schema、权限与 execute 各一格，外加类别、参数契约版本与是否支持入参复用。
 * 只有 `utils/tool.ts` 用，不出包。
 */

import type { ToolCategoryId } from '@velaros-ai/agent/protocol'

import type { VelaTool } from '../contract/provides.js'

/** 定义一个项目工具时给 `defineProjectTool` 的入参：每条工具自己写类别，说明各节只写真有内容的那几节。 */
export interface DefineProjectToolInput<TInput extends Record<string, any>> {
  /** 模型可调用的 canonical 工具名。 */
  name: string
  /** 这条工具的参数契约版本；不写就取本包的缺省版本。 */
  inputContractVersion?: number
  /** 失败后入参可复用：失败回执带 inputReuse，下一次用 reuse + changes 只改出问题的字段。执行器在 execute 之前把复用请求还原成完整入参。 */
  inputReuse?: boolean
  /** 工具所属类别。 */
  category: ToolCategoryId
  /** 工具角色，决定读改分离与执行策略。 */
  role: 'inspect' | 'edit' | 'execute'
  /** 一句话摘要。 */
  summary: string
  /** 适合用它的场景，至少一条。 */
  suitable: readonly [string, ...string[]]
  /** 禁止用它的场景。 */
  forbidden?: readonly [string, ...string[]]
  /** 必须照做的流程门禁。 */
  protocol?: readonly [string, ...string[]]
  /** 怎么用它。 */
  usage?: readonly [string, ...string[]]
  /** 可以直接照抄的入参示例，至少一条。 */
  examples: readonly [Record<string, unknown>, ...Array<Record<string, unknown>>]
  /** 示例讲不出来的注意事项。 */
  notes?: readonly [string, ...string[]]
  /** 入参 schema。 */
  schema: VelaTool<TInput>['schema']
  /** 调用它需要的权限。 */
  permissions: VelaTool<TInput>['permissions']
  /** 能力声明：副作用、读写域、并发性。 */
  capabilities?: VelaTool<TInput>['capabilities']
  /** 暴露策略：分层、排序、是否常驻。 */
  exposure?: VelaTool<TInput>['exposure']
  /** 运行依赖不存在时不进入工具发现目录。 */
  hideWhenUnavailable?: VelaTool<TInput>['hideWhenUnavailable']
  /** 当前上下文里这条工具能不能用。 */
  isAvailable?: VelaTool<TInput>['isAvailable']
  /** 这次入参下能不能与别的调用并发。 */
  isConcurrencySafe?: VelaTool<TInput>['isConcurrencySafe']
  /** 真正干活的那个函数。 */
  execute: VelaTool<TInput>['execute']
}
