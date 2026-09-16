import type { KernelSessionInputStore } from '../../contract/requires.js'
import type { AdmitKernelSessionInput, KernelAdmittedInput, KernelSessionInputSnapshotPersistence, PromoteKernelInputOptions } from '../../types/execution.js'

import { InMemoryKernelSessionInputStore } from './InMemoryKernelSessionInputStore'

export class PersistentKernelSessionInputStore implements KernelSessionInputStore {
  private delegatePromise: Nullable<Promise<InMemoryKernelSessionInputStore>> = null
  private mutationChain: Promise<void> = Promise.resolve()

  public constructor(private readonly persistence: KernelSessionInputSnapshotPersistence) {}

  public admit(input: AdmitKernelSessionInput): Promise<KernelAdmittedInput> {
    return this.mutate((store) => store.admit(input))
  }

  public list(sessionId: string): Promise<KernelAdmittedInput[]> {
    return this.read((store) => store.list(sessionId))
  }

  public countPending(sessionId: string): Promise<number> {
    return this.read((store) => store.countPending(sessionId))
  }

  public promoteSteers(
    sessionId: string,
    options: PromoteKernelInputOptions = {}
  ): Promise<KernelAdmittedInput[]> {
    return this.mutate((store) => store.promoteSteers(sessionId, options))
  }

  public promoteNextQueued(sessionId: string): Promise<Nullable<KernelAdmittedInput>> {
    return this.mutate((store) => store.promoteNextQueued(sessionId))
  }

  public cancel(sessionId: string, inputId?: string): Promise<number> {
    return this.mutate((store) => store.cancel(sessionId, inputId))
  }

  public dropSession(sessionId: string): Promise<number> {
    return this.mutate((store) => store.dropSession(sessionId))
  }

  private delegate(): Promise<InMemoryKernelSessionInputStore> {
    if (!this.delegatePromise) {
      this.delegatePromise = Promise.resolve(this.persistence.loadSnapshot()).then(
        (snapshot) => new InMemoryKernelSessionInputStore(snapshot)
      )
    }
    return this.delegatePromise
  }

  private async read<T>(operation: (store: InMemoryKernelSessionInputStore) => T): Promise<T> {
    await this.mutationChain
    return operation(await this.delegate())
  }

  private mutate<T>(operation: (store: InMemoryKernelSessionInputStore) => T): Promise<T> {
    const next = this.mutationChain.then(async () => {
      const store = await this.delegate()
      const result = operation(store)
      await this.persistence.saveSnapshot(store.snapshot())
      return result
    })
    this.mutationChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}
