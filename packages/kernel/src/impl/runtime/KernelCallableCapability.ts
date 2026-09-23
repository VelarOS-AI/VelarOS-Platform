import { isBlank, isUndefined } from '@velaros-ai/core'

import type {
  KernelCallableCapabilityOperation,
  KernelCallableCapabilityService,
  KernelCapabilityOperationMetadata,
} from '../../contract/requires'
import type { ScopeRef } from '../../types/kernel.js'
import { unknownOperationFailure } from '../../utils/errors'
import { normalizeKernelOperationMetadata } from '../../utils/runtime/callable'

/**
 * 一件能力的操作表。
 *
 * 表在构造时就闭合：只有静态声明过的自有操作能被调到，继承来的属性与任何别的字符串一律
 * 在求权限之前失败。中止信号在进 provider 之前查一次，免得已经取消的调用还产生副作用。
 */
export class KernelCallableCapability implements KernelCallableCapabilityService {
  private readonly operations = new Map<
    string,
    {
      readonly metadata: KernelCapabilityOperationMetadata
      readonly invoke: KernelCallableCapabilityOperation['invoke']
    }
  >()

  public constructor(operations: Readonly<Record<string, KernelCallableCapabilityOperation>>) {
    for (const [operation, definition] of Object.entries(operations)) {
      if (isBlank(operation.trim())) {
        throw new Error('可调用能力的操作名不能为空')
      }
      this.operations.set(
        operation,
        Object.freeze({
          metadata: normalizeKernelOperationMetadata(operation, definition.metadata),
          invoke: definition.invoke,
        })
      )
    }
  }

  /**
   * 取一条操作的权限声明；没登记过就返回 undefined，调用方据此在求权限之前拒绝。
   *
   * 写成实例字段而不是原型方法：能力包普遍用 `{ ...callable, 自己的方法 }` 把可调用面并进
   * 自己的服务对象，展开只带得走自有属性；挂在原型上会让那一圈包当场丢掉这两个方法。
   */
  public readonly getOperationMetadata = (
    operation: string
  ): KernelCapabilityOperationMetadata | undefined => this.operations.get(operation)?.metadata

  /** 执行一条已登记的操作；未知操作与已中止的调用都不会进到 provider 代码。 */
  public readonly invoke = (
    operation: string,
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal
  ): unknown | Promise<unknown> => {
    const definition = this.operations.get(operation)
    if (isUndefined(definition)) throw unknownOperationFailure()
    if (signal.aborted) {
      throw new DOMException('能力调用已被中止', 'AbortError')
    }
    return definition.invoke(scope, input, signal)
  }
}
