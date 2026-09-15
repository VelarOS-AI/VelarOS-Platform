/**
 * 工具：定义系统工具。严格解析线上入参、包装成内核可调用操作用 `@velaros-ai/agent/tool-contract` 的公共实现。
 */

import { defineToolRuntimeSpec, withToolInputReuse } from '@velaros-ai/agent/tool-contract'

import { SystemToolCategoryByName } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type { DefineSystemToolInput } from '../types/tool.js'

/** 定义一个系统工具：类别按工具名自动查表填上，保证一个工具只属于一个类别；声明了 inputReuse 的工具，示例按原 schema 校验后再套上复用信封。 */
export function defineSystemTool<TInput extends Record<string, unknown>>(
  input: DefineSystemToolInput<TInput>
): VelaTool<TInput> {
  const { inputReuse, ...spec } = input
  const defined = defineToolRuntimeSpec({
    ...spec,
    category: SystemToolCategoryByName[input.name],
  })
  if (!inputReuse) return defined
  return Object.freeze({ ...defined, schema: withToolInputReuse(defined.schema) }) as VelaTool<TInput>
}
