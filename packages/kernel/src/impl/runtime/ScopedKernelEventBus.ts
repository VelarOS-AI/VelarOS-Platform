import type { KernelRegistration } from '../../contract/provides'
import type { KernelEventHandler } from '../../contract/requires'
import type { KernelEvent } from '../../types/kernel.js'

import type { KernelEventHub } from './KernelEventHub'

/**
 * 一个模块看到的事件总线视图。
 *
 * 模块只能以自己的身份发事件、以自己的代际订阅事件：来源模块 id 与代际由宿主在这里补上，
 * 模块给不了别的值。上下文失效（模块被释放或被替换）之后再发再订阅都会被 `assertActive` 拦住。
 */
export interface KernelModuleEventBus {
  /** 以本模块的身份发一条事件；上下文失效时抛 `MODULE_STATE`。 */
  publish<TPayload>(type: string, payload: TPayload): Promise<KernelEvent<TPayload>>
  /** 以本模块的身份订阅一类事件；模块释放时订阅随代际一起清掉。 */
  subscribe<TPayload>(type: string, handler: KernelEventHandler<TPayload>): KernelRegistration
}

export class ScopedKernelEventBus implements KernelModuleEventBus {
  public constructor(
    private readonly hub: KernelEventHub,
    private readonly moduleId: string,
    private readonly generation: number,
    private readonly assertActive: () => void,
    private readonly isDeliveryEnabled: () => boolean
  ) {}

  public publish<TPayload>(type: string, payload: TPayload): Promise<KernelEvent<TPayload>> {
    this.assertActive()
    return this.hub.publish(this.moduleId, this.generation, type, payload, this.isDeliveryEnabled())
  }

  public subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>
  ): KernelRegistration {
    this.assertActive()
    return this.hub.subscribe(this.moduleId, this.generation, type, handler, this.isDeliveryEnabled)
  }
}
