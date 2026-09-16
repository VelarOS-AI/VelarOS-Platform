import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { NonEmptyToolContractList } from '../../types/toolkit.js'


function serializeToolExampleInput(value: unknown): string {
  try {
    // 模型示例与真实 JSON 调用共用编码规则：正确转义键和值，缺省字段保持省略。
    const serialized = JSON.stringify(value)
    if (isString(serialized)) return serialized
  } catch (cause) {
    throw new AppError(
      'VALIDATION',
      '工具调用示例必须能被 JSON.stringify 序列化：这份示例里出现了循环引用或 BigInt 这类 JSON 编不出来的值。示例会原样进模型提示词，请改成纯 JSON 值再登记。',
      cause
    )
  }
  throw new AppError(
    'VALIDATION',
    '工具调用示例序列化后没有 JSON 表示：示例本身是 undefined、函数或 symbol 这类 JSON.stringify 会直接丢掉的值。请把它换成一个参数对象再登记。'
  )
}

function renderToolExampleInputs(
  examples: NonEmptyToolContractList<Record<string, unknown>>
): NonEmptyToolContractList {
  const [firstExample, ...remainingExamples] = examples
  const rendered: [string, ...string[]] = [
    `调用参数示例：${serializeToolExampleInput(firstExample)}。`,
    ...remainingExamples.map((example) => `调用参数示例：${serializeToolExampleInput(example)}。`),
  ]
  return rendered
}

/**
 * 工具调用示例登记表：工具定义期把「这个工具该怎么调」的参数样例存起来，装配描述时再取出来渲染。
 *
 * 进程内一份共享实例（`DefaultToolContractExampleRegistry`）贯穿工具定义与工具描述渲染两端；
 * 按工具名覆盖写入，查不到时返回 undefined，调用方自己决定要不要兜底。
 */
export interface ToolContractExampleRegistryApi {
  /** 登记某个工具的参数样例；同名再写一次直接覆盖，最后一次定义说了算。 */
  set(toolName: string, examples: ReadonlyArray<Record<string, unknown>>): void
  /** 取某个工具登记过的参数样例；没登记过返回 undefined（不是空数组，好让调用方区分"没有"和"空的"）。 */
  get(toolName: string): ReadonlyArray<Record<string, unknown>> | undefined
  /** 取整张表的快照；返回副本，之后的写入不会再改到已经拿走的这份。 */
  snapshot(): ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>
}

class ToolContractExampleRegistry implements ToolContractExampleRegistryApi {
  private readonly examplesByToolName = new Map<string, ReadonlyArray<Record<string, unknown>>>()

  public set(toolName: string, examples: ReadonlyArray<Record<string, unknown>>): void {
    this.examplesByToolName.set(toolName, examples)
  }

  public get(toolName: string): ReadonlyArray<Record<string, unknown>> | undefined {
    return this.examplesByToolName.get(toolName)
  }

  /** 返回副本：注册表在工具定义期持续被写入，快照必须与后续写入解耦。 */
  public snapshot(): ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>> {
    return new Map(this.examplesByToolName)
  }
}

/** 进程内共享的那一份示例登记表：工具定义端写入，描述渲染端读出。 */
export const DefaultToolContractExampleRegistry: ToolContractExampleRegistry = new ToolContractExampleRegistry()

export {
  renderToolExampleInputs,
  serializeToolExampleInput,
  ToolContractExampleRegistry,
}
