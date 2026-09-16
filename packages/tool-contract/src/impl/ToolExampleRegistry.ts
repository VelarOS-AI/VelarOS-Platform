/**
 * 工具调用示例的登记表与渲染：定义工具时把示例存起来，装配说明时取出来渲染成「示例：」分节。
 * 接口 `ToolExampleRegistryApi` 在本文件的类上方；整个进程一份 `toolExamples`。
 */

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { NonEmptyToolContractList } from '../types/tool-contract.js'

/**
 * 工具调用示例登记表：工具定义期把「这个工具该怎么调」的参数样例存起来，装配描述时再取出来渲染。
 *
 * 进程内一份共享实例（`toolExamples`）贯穿工具定义与工具描述渲染两端；
 * 按工具名覆盖写入，查不到时返回 undefined，调用方自己决定要不要兜底。
 * 要一份与进程共享表隔离的登记表（测试、离线审核）时用 `createToolExampleRegistry`。
 */
export interface ToolExampleRegistryApi {
  /** 登记某个工具的参数样例；同名再写一次直接覆盖，最后一次定义说了算。 */
  set(toolName: string, examples: ReadonlyArray<Record<string, unknown>>): void
  /** 取某个工具登记过的参数样例；没登记过返回 undefined（不是空数组，好让调用方区分"没有"和"空的"）。 */
  get(toolName: string): ReadonlyArray<Record<string, unknown>> | undefined
  /** 取整张表的快照；返回副本，之后的写入不会再改到已经拿走的这份。 */
  snapshot(): ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>
}

class ToolExampleRegistry implements ToolExampleRegistryApi {
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

/** 造一张独立的示例登记表：与进程共享的那份互不影响，给测试与离线审核用。 */
export function createToolExampleRegistry(): ToolExampleRegistryApi {
  return new ToolExampleRegistry()
}

/**
 * 把一条示例编成模型实际会收到的那串 JSON。循环引用、BigInt 这类编不出来的值，以及
 * undefined、函数、symbol 这类会被整个丢掉的值，都在这里抛 `VALIDATION`——示例原样进提示词，
 * 坏示例必须在装配期炸，不能等模型照着抄才发现。
 */
export function serializeToolExampleInput(value: unknown): string {
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

/** 把一组示例渲染成「示例：」分节的条目，每条一句「调用参数示例：<JSON>。」。 */
export function renderToolExampleInputs(
  examples: NonEmptyToolContractList<Record<string, unknown>>
): NonEmptyToolContractList {
  const [firstExample, ...remainingExamples] = examples
  const rendered: [string, ...string[]] = [
    `调用参数示例：${serializeToolExampleInput(firstExample)}。`,
    ...remainingExamples.map((example) => `调用参数示例：${serializeToolExampleInput(example)}。`),
  ]
  return rendered
}

/** 进程内共享的那一份示例登记表：工具定义端写入，描述渲染端读出。 */
export const toolExamples: ToolExampleRegistryApi = new ToolExampleRegistry()
