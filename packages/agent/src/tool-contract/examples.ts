import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { NonEmptyToolContractList } from './types'

function serializeToolExampleInput(value: unknown): string {
  try {
    // 模型示例与真实 JSON 调用共用编码规则：正确转义键和值，缺省字段保持省略。
    const serialized = JSON.stringify(value)
    if (isString(serialized)) return serialized
  } catch (cause) {
    throw new AppError('VALIDATION', 'Tool example must be JSON-serializable.', cause)
  }
  throw new AppError('VALIDATION', 'Tool example must have a JSON wire representation.')
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

class ToolContractExampleRegistry {
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

const DefaultToolContractExampleRegistry = new ToolContractExampleRegistry()

export {
  DefaultToolContractExampleRegistry,
  renderToolExampleInputs,
  serializeToolExampleInput,
  ToolContractExampleRegistry,
}
