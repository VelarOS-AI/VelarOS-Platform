import { Log } from '@velaros-ai/core'

import type { KernelRegistration } from '../../contract/provides'
import type { KernelEventHandler } from '../../contract/requires'
import type { KernelEvent } from '../../types/kernel.js'
import type { EventSubscription } from '../../types/runtime'

import type { KernelModuleEventBus } from './ScopedKernelEventBus'
import { ScopedKernelEventBus } from './ScopedKernelEventBus'

const log = Log.tag('KernelEventHub')

/**
 * 整个内核里唯一的事件中枢：按事件类型存订阅，按模块与代际归属。
 *
 * 实例由 `KernelModuleHost` 持一份，模块拿到的是收窄过的 {@link KernelModuleEventBus}。
 */
export interface KernelEventHubApi {
  /** 造一个模块作用域的总线视图，把模块 id、代际与两道闸绑上去。 */
  forModule(
    moduleId: string,
    generation: number,
    assertActive: () => void,
    isDeliveryEnabled?: () => boolean,
  ): KernelModuleEventBus
  /**
   * 发一条事件。
   *
   * 订阅者之间相互隔离：一个回调抛错只记日志，后面的订阅者照收，发布方也不因此失败。
   * `deliver` 为 false 时只造出事件对象、不投递（替换模块时新代在暂存门后面用）。
   */
  publish<TPayload>(
    sourceModuleId: string,
    sourceGeneration: number,
    type: string,
    payload: TPayload,
    deliver?: boolean,
  ): Promise<KernelEvent<TPayload>>
  /** 订阅一类事件；返回的登记 dispose 之后就不再收。 */
  subscribe<TPayload>(
    ownerModuleId: string,
    generation: number,
    type: string,
    handler: KernelEventHandler<TPayload>,
    isDeliveryEnabled?: () => boolean,
  ): KernelRegistration
  /** 摘掉某个模块某一代的全部订阅；模块释放或换代时由宿主调。 */
  removeOwner(ownerModuleId: string, generation: number): void
}

export class KernelEventHub implements KernelEventHubApi {
  private readonly subscriptions = new Map<string, Set<EventSubscription>>()
  private sequence = 0

  public forModule(
    moduleId: string,
    generation: number,
    assertActive: () => void,
    isDeliveryEnabled: () => boolean = () => true,
  ): KernelModuleEventBus {
    return new ScopedKernelEventBus(
      this,
      moduleId,
      generation,
      assertActive,
      isDeliveryEnabled,
    )
  }

  public async publish<TPayload>(
    sourceModuleId: string,
    sourceGeneration: number,
    type: string,
    payload: TPayload,
    deliver = true,
  ): Promise<KernelEvent<TPayload>> {
    const event: KernelEvent<TPayload> = Object.freeze({
      type,
      payload,
      sourceModuleId,
      sourceGeneration,
      sequence: ++this.sequence,
    })
    if (!deliver) return event
    // 订阅者之间相互隔离：一个回调抛错只记日志，后面的订阅者照收，发布方也不因此失败。
    // 不隔离等于「任何一个模块的订阅回调都能让别的模块的 publish 失败」，是跨模块的故障传染。
    const subscriptions = [...(this.subscriptions.get(type) ?? [])]
    for (const subscription of subscriptions) {
      if (!subscription.isDeliveryEnabled()) continue
      try {
        await subscription.handler(event)
      } catch (error) {
        log.warn('事件订阅者处理失败，已跳过该订阅者', {
          error,
          eventType: type,
          sourceModuleId,
          subscriberModuleId: subscription.ownerModuleId,
        })
      }
    }
    return event
  }

  public subscribe<TPayload>(
    ownerModuleId: string,
    generation: number,
    type: string,
    handler: KernelEventHandler<TPayload>,
    isDeliveryEnabled: () => boolean = () => true,
  ): KernelRegistration {
    const subscriptions = this.subscriptions.get(type) ?? new Set()
    if (!this.subscriptions.has(type)) {
      this.subscriptions.set(type, subscriptions)
    }

    const subscription: EventSubscription = {
      ownerModuleId,
      generation,
      handler: (event: KernelEvent) => handler(event as KernelEvent<TPayload>),
      isDeliveryEnabled,
    }
    subscriptions.add(subscription)
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        subscriptions.delete(subscription)
        if (subscriptions.size === 0) this.subscriptions.delete(type)
      },
    }
  }

  public removeOwner(ownerModuleId: string, generation: number): void {
    for (const [type, subscriptions] of this.subscriptions) {
      for (const subscription of subscriptions) {
        if (
          subscription.ownerModuleId === ownerModuleId
          && subscription.generation === generation
        ) {
          subscriptions.delete(subscription)
        }
      }
      if (subscriptions.size === 0) this.subscriptions.delete(type)
    }
  }
}
