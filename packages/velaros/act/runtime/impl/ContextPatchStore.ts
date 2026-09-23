import type { ContextState, ContextStorage } from '@velaros-ai/context'

/** 当前会话元数据的短暂提交缓冲，原文沿用原对象存储。 */
export interface ContextPatchStoreApi extends ContextStorage {
  /** 读取当前暂存状态。 */
  load(sessionId: string): Promise<Nullable<ContextState>>
  /** 在暂存状态上执行既有操作的版本校验。 */
  compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean>
  /** 不可变正文继续写入原存储，未发布对象不获得可见引用。 */
  put(sessionId: string, text: string): Promise<string>
  /** 仅读取目标会话正文。 */
  get(sessionId: string, objectId: string): Promise<Nullable<string>>
  /** 关闭提交缓冲，不关闭共享存储。 */
  close(): Promise<void>
  /** 将整组通过校验的元数据一次发布，冲突时整组不生效。 */
  commit(signal: AbortSignal): Promise<boolean>
}

/** 仅上下文元数据具备原子发布；不包含脚本执行或外部效果。 */
export class ContextPatchStore implements ContextPatchStoreApi {
  private state: ContextState
  private closed = false
  public constructor(
    private readonly id: string,
    private readonly storage: ContextStorage,
    private readonly base: ContextState
  ) {
    this.state = structuredClone(base)
  }
  private check(sessionId: string): void {
    if (this.closed || sessionId !== this.id) throw new Error('上下文提交缓冲已关闭或引用越界')
  }
  public async load(sessionId: string) {
    this.check(sessionId)
    return structuredClone(this.state)
  }
  public async compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState) {
    this.check(sessionId)
    if (this.state.version !== expectedVersion) return false
    this.state = structuredClone(state)
    return true
  }
  public async put(sessionId: string, text: string) {
    this.check(sessionId)
    return this.storage.put(sessionId, text)
  }
  public async get(sessionId: string, objectId: string) {
    this.check(sessionId)
    return this.storage.get(sessionId, objectId)
  }
  public async close(): Promise<void> {
    this.closed = true
  }
  public async commit(signal: AbortSignal): Promise<boolean> {
    this.check(this.id)
    signal.throwIfAborted()
    const committed = await this.storage.compareAndSwap(this.id, this.base.version, {
      ...this.state,
      version: this.base.version + 1,
    })
    this.closed = true
    return committed
  }
}
