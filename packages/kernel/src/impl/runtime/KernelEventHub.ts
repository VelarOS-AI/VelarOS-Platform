import { Log } from '@velaros-ai/core'

import type {
  KernelEvent,
  KernelEventHandler,
  KernelModuleEventBus,
} from '../../types/abi-events'
import type { KernelRegistration } from '../../types/abi-module'

import { ScopedKernelEventBus } from './ScopedKernelEventBus'

const log = Log.tag('KernelEventHub')

interface EventSubscription {
  readonly ownerModuleId: string
  readonly generation: number
  readonly handler: KernelEventHandler
  readonly isDeliveryEnabled: () => boolean
}

export class KernelEventHub {
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
      handler: (event) => handler(event as KernelEvent<TPayload>),
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
