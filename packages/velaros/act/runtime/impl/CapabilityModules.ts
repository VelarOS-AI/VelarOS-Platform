import { isFunction, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { OperationDefinition, OperationModuleDefinition } from '@velaros-ai/kernel'

import type { CapabilityModuleOptions } from '../contract/requires.js'
import { isFailureWithoutEffect } from '../utils/effects.js'
import { normalizeCapabilityValue } from '../utils/results.js'

/**
 * 把生成的模型面接到它的操作实现上：业务能力与 Act 自管理能力走同一条校验、派发、效果与持久回执链。
 * 模型面（声明、schema、效果、允许的入口）只来自操作接口生成的 surface，这里只补宿主上下文、版本读取与效果核对。
 * 写操作失败时，带着「没有写入」约定标记的错误（见 {@link isFailureWithoutEffect}）一律记成没有效果，
 * 领域的 `withoutEffect` 只需认标记以外的写前失败；两样都不认的才是效果未知，要等宿主核对。
 */
export interface CapabilityModulesApi {
  /** 按一份生成的模型面装配 Kernel 模块；实现缺了哪个方法当场报错。 */
  create<T extends object>(options: CapabilityModuleOptions<T>): OperationModuleDefinition
}

class CapabilityModules implements CapabilityModulesApi {
  public create<T extends object>(options: CapabilityModuleOptions<T>): OperationModuleDefinition {
    const { surface, implementation } = options
    if (
      surface.methods.length !== Object.keys(surface.operations).length ||
      new Set(surface.methods).size !== surface.methods.length
    )
      throw new AppError('INVARIANT', '领域声明与操作表不一致')
    const operations: Record<string, OperationDefinition> = Object.create(null)
    for (const name of surface.methods) {
      const operation = surface.operations[name]
      const handler = Reflect.get(implementation, name)
      if (!operation || !isFunction(handler))
        throw new AppError('INVARIANT', `领域实现缺少 ${surface.specifier}.${name}`)
      const { hasInput, ...descriptor } = operation
      const reconcile = options.reconcile?.[name as keyof T]
      const observe = options.observation?.[name as keyof T]
      operations[name] = {
        ...descriptor,
        reads: options.reads?.[name as keyof T] ? options.reads[name as keyof T] : undefined,
        observe: toOptional(observe),
        reconcile: toOptional(reconcile),
        run: async (input, call) => {
          call.signal.throwIfAborted()
          let effectRecorded = false
          try {
            const context = await options.context({
              ...call,
              recordEffect: (effect) => {
                effectRecorded = true
                call.recordEffect(effect)
              },
            })
            call.signal.throwIfAborted()
            const value: unknown = await Reflect.apply(
              handler,
              implementation,
              hasInput ? [input, context] : [context]
            )
            if (!effectRecorded)
              call.recordEffect(descriptor.effects === 'none' ? 'none' : 'committed')
            return normalizeCapabilityValue(value)
          } catch (error) {
            if (
              !effectRecorded &&
              (isFailureWithoutEffect(error) || options.withoutEffect?.(error))
            )
              call.recordEffect('none')
            throw error
          }
        },
      }
    }
    return {
      binding: {
        moduleId: surface.specifier,
        instanceId: options.instanceId,
        generation: options.generation ?? 1,
        schemaRevision: surface.revision,
      },
      summary: options.summary ?? surface.specifier,
      surface,
      operations,
      activate: options.activate ? () => options.activate!() : undefined,
      dispose: options.dispose ? () => options.dispose!() : undefined,
    }
  }
}

/** 整个进程只有一份的装配器。 */
export const capabilityModules: CapabilityModulesApi = new CapabilityModules()

/** 对外入口的工厂：宿主挂业务能力时用它，同 `capabilityModules.create`。 */
export function createCapabilityModule<T extends object>(
  options: CapabilityModuleOptions<T>
): OperationModuleDefinition {
  return capabilityModules.create(options)
}
