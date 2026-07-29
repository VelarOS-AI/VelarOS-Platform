import type {
  KernelEvent,
  KernelEventHandler,
  KernelModuleEventBus,
  KernelRegistration,
} from '../abi'

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
    return {
      publish: <TPayload>(type: string, payload: TPayload) => {
        assertActive()
        return this.publish(
          moduleId,
          generation,
          type,
          payload,
          isDeliveryEnabled(),
        )
      },
      subscribe: <TPayload>(
        type: string,
        handler: KernelEventHandler<TPayload>,
      ) => {
        assertActive()
        return this.subscribe(
          moduleId,
          generation,
          type,
          handler,
          isDeliveryEnabled,
        )
      },
    }
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
    const subscriptions = [...(this.subscriptions.get(type) ?? [])]
    for (const subscription of subscriptions) {
      if (!subscription.isDeliveryEnabled()) continue
      await subscription.handler(event)
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
