/** 定义一条工具：实现在 `@velaros-ai/tool-contract`，这里按原名转发给 agent 自己与 `./tool-contract` 入口。 */

import type { ToolExampleRegistryApi } from '@velaros-ai/tool-contract'
import { toolContracts, toolExamples } from '@velaros-ai/tool-contract'

import type {
  DefineToolContractInput,
  DefineToolRuntimeSpecInput,
  ToolContractDescriptionSpec,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolReadOnlyClassification,
} from '../../types/toolkit.js'

/** 行为 effect 是只读真值；缺席时才采用显式声明，旧工具最后回退 role。 */
function resolveToolReadOnly(tool: ToolReadOnlyClassification): boolean {
  return toolContracts.isReadOnly(tool)
}

/**
 * 把描述规格编译成模型最终看到的那段工具描述，并**登记示例**（供 tool_map / schema 自恢复等处回查）。
 * companion skill 指路会追加进「注意」分节末尾。两道长度闸也在这里拦。
 */
function buildToolContractDescription(
  name: string,
  categoryId: DefineToolContractInput['category'],
  spec: ToolContractDescriptionSpec,
  examples: ToolExampleRegistryApi = toolExamples
): string {
  return toolContracts.describe(name, categoryId, spec, examples)
}

/** 声明一条工具**契约**（只有形状与描述，配 execute 但不含 runtime 独有字段）。 */
function defineToolContract<TInput extends Record<string, unknown>, TContext = unknown>(
  input: DefineToolContractInput<TInput, TContext>,
  examples: ToolExampleRegistryApi = toolExamples
): ToolContractSpec<TInput, TContext> {
  return toolContracts.define(input, examples)
}

/** 声明一条工具的**运行期规格**：契约那套校验全都照做，另外逐 surface 编译描述并定出 `readOnly`。 */
function defineToolRuntimeSpec<
  TInput extends Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = string,
>(
  input: DefineToolRuntimeSpecInput<TInput, TContext, TResult, TPermission>,
  examples: ToolExampleRegistryApi = toolExamples
): ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission> {
  return toolContracts.defineRuntime(input, examples)
}

/** 鸭子判定一个值是否是工具契约：同时具备 name、category、role、description、schema、execute 六个键即为真。 */
function isToolContractSpec(
  value: unknown
): value is ToolContractSpec<Record<string, unknown>, unknown> {
  return toolContracts.isContract(value)
}

export {
  buildToolContractDescription,
  defineToolContract,
  defineToolRuntimeSpec,
  isToolContractSpec,
  resolveToolReadOnly,
}
