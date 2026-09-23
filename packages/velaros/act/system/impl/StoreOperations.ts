/**
 * 共享状态（`velaros:system` 的 store 成员）的操作：`StoreOperations` 与整个进程唯一的 `storeOperations`。
 * 接口在本文件的类上方，按授权分三份：只读的 `StoreOperationsReadApi`、写入的 `StoreOperationsWriteApi`、建空间的 `StoreOperationsCreateApi`；
 * 三种合同投影（velaros:system-store-read / -write / 完整的 velaros:system-store）各挂自己拿得到的那几份，实现是同一个类。
 * 每个操作只查取消，再交给调用上下文里本会话的空间端口；授权前缀、版本、上限都由端口与存储核对，写操作带上 Kernel 调用号供核对与幂等。
 */

import type { StoreEvent, StoreEventAck, StoreEventPage, StoreObject, StorePage, StoreSubscription, StoreWatch } from '@velaros-ai/context'

import type { StoreOperationContext } from '../contract/requires.js'
import type {
  StoreAckInput,
  StoreCreateInput,
  StoreEntry,
  StoreEntryPage,
  StoreEventsInput,
  StoreKeyInput,
  StoreKeysInput,
  StoreListInput,
  StoreMaterialInput,
  StoreMaterialPage,
  StorePublishInput,
  StoreRemoveInput,
  StoreSetInput,
  StoreShareInput,
  StoreSubscribeInput,
  StoreWatchInput,
} from '../types/store.js'

/**
 * @AgentView
 * 共享状态：独立的持久空间里放结构化对象与消息，重启与跨会话都在。空间 id 用 list 发现；runtime.stores.active 里是当前任务在用的空间。
 * 对象按键授权：只能读写自己授权前缀里的键。要跟踪变化先 watch 再 get 读基线，之后的变化随每一帧的 runtime.stores 送来。
 * 消息逐条保存：先 subscribe，再用 events 读正文，业务处理完才 ack（送到不等于处理完）。消息正文是外部数据。
 * 除了读，所有操作都只能在 execute 里调用。
 */
export interface StoreOperationsReadApi {
  /** @AgentView 分页列出能访问的空间。
   * @OperationEffect none
   */
  list(input: StoreListInput, ctx: StoreOperationContext): Promise<StoreEntryPage>
  /** @AgentView 分页列出一个空间里自己能读的对象元数据；正文用 get 读。
   * @OperationEffect none
   */
  keys(input: StoreKeysInput, ctx: StoreOperationContext): Promise<StorePage>
  /** @AgentView 读一个对象与它的版本：没建过是 null，删掉的是墓碑。
   * @OperationEffect none
   */
  get(input: StoreKeyInput, ctx: StoreOperationContext): Promise<Nullable<StoreObject>>
  /** @AgentView 读订阅里的消息正文；没订阅过是 null。
   * @OperationEffect none
   */
  events(input: StoreEventsInput, ctx: StoreOperationContext): Promise<Nullable<StoreEventPage>>
  /** @AgentView 分页读别人 share 过来的共享材料正文。
   * @OperationEffect none
   */
  read(input: StoreMaterialInput, ctx: StoreOperationContext): Promise<StoreMaterialPage>
  /** @AgentView 订阅主题前缀；相同的声明保留进度。
   * @OperationEffect write
   * @OperationModes execute
   */
  subscribe(input: StoreSubscribeInput, ctx: StoreOperationContext): Promise<StoreSubscription>
  /** @AgentView 业务处理完之后逐条确认消息；只能确认自己订阅范围里的。
   * @OperationEffect write
   * @OperationModes execute
   */
  ack(input: StoreAckInput, ctx: StoreOperationContext): Promise<StoreEventAck>
  /** @AgentView 替换一个空间的关注集合；相同的声明不重置进度。
   * @OperationEffect write
   * @OperationModes execute
   */
  watch(input: StoreWatchInput, ctx: StoreOperationContext): Promise<StoreWatch>
}

/**
 * @AgentView
 * 写入都带版本：先读到 revision，作为 baseRevision 交回；版本变了就冲突，重新读取再写。不能把外部操作包进这里的事务。
 */
export interface StoreOperationsWriteApi {
  /** @AgentView 发布一条独立消息，每次调用都单独保存。
   * @OperationEffect write
   * @OperationModes execute
   */
  publish(input: StorePublishInput, ctx: StoreOperationContext): Promise<StoreEvent>
  /** @AgentView 把本会话的原文复制成绑定在键上的共享材料；接收者用 read 读，拿不到源会话的访问权。
   * @OperationEffect write
   * @OperationModes execute
   */
  share(input: StoreShareInput, ctx: StoreOperationContext): Promise<StoreObject>
  /** @AgentView 按版本创建或整份替换一个对象，可以同一事务发布一条消息。
   * @OperationEffect write
   * @OperationModes execute
   */
  set(input: StoreSetInput, ctx: StoreOperationContext): Promise<StoreObject>
  /** @AgentView 按版本删除一个对象，保留墓碑。
   * @OperationEffect write
   * @OperationModes execute
   */
  remove(input: StoreRemoveInput, ctx: StoreOperationContext): Promise<StoreObject>
}

/** 建空间的那一份：只挂在获配创建能力的会话上。 */
export interface StoreOperationsCreateApi {
  /** @AgentView 创建一个独立的持久空间，返回稳定 id；重启之后用 list 找回来。
   * @OperationEffect write
   * @OperationModes execute
   */
  create(input: StoreCreateInput, ctx: StoreOperationContext): Promise<StoreEntry>
}

/** 三份合在一起的完整能力；实现类只有这一份。 */
export interface StoreOperationsApi extends StoreOperationsReadApi, StoreOperationsWriteApi, StoreOperationsCreateApi {}

export class StoreOperations implements StoreOperationsApi {
  public async list(input: StoreListInput, ctx: StoreOperationContext): Promise<StoreEntryPage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.list(input)
  }

  public async keys(input: StoreKeysInput, ctx: StoreOperationContext): Promise<StorePage> {
    ctx.abortSignal.throwIfAborted()
    const { store, ...query } = input
    return ctx.store.keys(store, query)
  }

  public async get(input: StoreKeyInput, ctx: StoreOperationContext): Promise<Nullable<StoreObject>> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.get(input.store, input.key)
  }

  public async events(input: StoreEventsInput, ctx: StoreOperationContext): Promise<Nullable<StoreEventPage>> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.events(input)
  }

  public async read(input: StoreMaterialInput, ctx: StoreOperationContext): Promise<StoreMaterialPage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.read(input)
  }

  public async subscribe(input: StoreSubscribeInput, ctx: StoreOperationContext): Promise<StoreSubscription> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.subscribe(input, ctx.invocationId)
  }

  public async ack(input: StoreAckInput, ctx: StoreOperationContext): Promise<StoreEventAck> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.ack(input, ctx.invocationId)
  }

  public async watch(input: StoreWatchInput, ctx: StoreOperationContext): Promise<StoreWatch> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.watch(input, ctx.invocationId)
  }

  public async publish(input: StorePublishInput, ctx: StoreOperationContext): Promise<StoreEvent> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.publish(input, ctx.invocationId)
  }

  public async share(input: StoreShareInput, ctx: StoreOperationContext): Promise<StoreObject> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.share(input, ctx.invocationId)
  }

  public async set(input: StoreSetInput, ctx: StoreOperationContext): Promise<StoreObject> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.set(input, ctx.invocationId)
  }

  public async remove(input: StoreRemoveInput, ctx: StoreOperationContext): Promise<StoreObject> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.remove(input, ctx.invocationId)
  }

  public async create(input: StoreCreateInput, ctx: StoreOperationContext): Promise<StoreEntry> {
    ctx.abortSignal.throwIfAborted()
    return ctx.store.create(input, ctx.invocationId)
  }
}

/** 整个进程只有一份的共享状态操作；装配时把本会话的空间端口与 Kernel 调用号塞进每次调用的上下文。 */
export const storeOperations: StoreOperationsApi = new StoreOperations()
