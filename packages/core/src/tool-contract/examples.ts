import { isArray, isBoolean, isNull, isNumber, isRecord, isString } from '../typeGuards'
import { isEmpty } from '../utils/array.js'

import type { NonEmptyToolContractList } from './types'

function serializeToolExampleInput(value: unknown): string {
  if (isString(value)) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/'/g, "\\'")

    return `'${escaped}'`
  }
  if (isNumber(value) || isBoolean(value)) return String(value)
  if (isNull(value)) return 'null'
  if (isArray(value)) return `[${value.map(serializeToolExampleInput).join(', ')}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, nested]) => {
      const renderedKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`
      return `${renderedKey}: ${serializeToolExampleInput(nested)}`
    })
    return isEmpty(entries) ? '{}' : `{ ${entries.join(', ')} }`
  }
  return 'null'
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
