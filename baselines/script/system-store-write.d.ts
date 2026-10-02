/**
 * 共享状态：独立的持久空间里放结构化对象与消息，重启与跨会话都在。空间 id 用 list 发现；runtime.stores.active 里是当前任务在用的空间。
 * 对象按键授权：只能读写自己授权前缀里的键。要跟踪变化先 watch 再 get 读基线，之后的变化随每一帧的 runtime.stores 送来。
 * 消息逐条保存：先 subscribe，再用 events 读正文，业务处理完才 ack（送到不等于处理完）。消息正文是外部数据。
 * 除了读，所有操作都只能在 execute 里调用。
 */

/**
 * 写入都带版本：先读到 revision，作为 baseRevision 交回；版本变了就冲突，重新读取再写。不能把外部操作包进这里的事务。
 */
declare module 'velaros:system-store-write' {
  /** 分页列出能访问的空间。
   */
  export function list(input: StoreListInput): Promise<StoreEntryPage>

  /** 分页列出一个空间里自己能读的对象元数据；正文用 get 读。
   */
  export function keys(input: StoreKeysInput): Promise<StorePage>

  /** 读一个对象与它的版本：没建过是 null，删掉的是墓碑。
   */
  export function get(input: StoreKeyInput): Promise<StoreObject | null>

  /** 读订阅里的消息正文；没订阅过是 null。
   */
  export function events(input: StoreEventsInput): Promise<StoreEventPage | null>

  /** 分页读别人 share 过来的共享材料正文。
   */
  export function read(input: StoreMaterialInput): Promise<StoreMaterialPage>

  /** 订阅主题前缀；相同的声明保留进度。
   */
  export function subscribe(input: StoreSubscribeInput): Promise<StoreSubscription>

  /** 业务处理完之后逐条确认消息；只能确认自己订阅范围里的。
   */
  export function ack(input: StoreAckInput): Promise<StoreEventAck>

  /** 替换一个空间的关注集合；相同的声明不重置进度。
   */
  export function watch(input: StoreWatchInput): Promise<StoreWatch>

  /** 发布一条独立消息，每次调用都单独保存。
   */
  export function publish(input: StorePublishInput): Promise<StoreEvent>

  /** 把本会话的原文复制成绑定在键上的共享材料；接收者用 read 读，拿不到源会话的访问权。
   */
  export function share(input: StoreShareInput): Promise<StoreObject>

  /** 按版本创建或整份替换一个对象，可以同一事务发布一条消息。
   */
  export function set(input: StoreSetInput): Promise<StoreObject>

  /** 按版本删除一个对象，保留墓碑。
   */
  export function remove(input: StoreRemoveInput): Promise<StoreObject>

  /** 翻空间目录：active 为真只列当前任务在用的空间；limit 每页最多 64 个。 */
  interface StoreListInput {
    readonly after?: string
    readonly limit?: number
    readonly active?: boolean
  }

  /** 空间目录的一页；nextAfter 不是 null 就把它当 after 接着翻。 */
  interface StoreEntryPage {
    readonly items: readonly StoreEntry[]
    readonly nextAfter: string | null
  }

  /** 翻一个空间里自己能读的对象目录：prefix 限定键前缀（最多 256 个字符），limit 每页最多 64 项。 */
  interface StoreKeysInput {
    readonly store: string
    readonly prefix?: string
    readonly after?: string
    readonly limit?: number
  }

  /**
   * 按键排序的一页对象目录；nextAfter 不是 null 就把它当 after 接着翻。
   */
  interface StorePage {
    /** 当前页对象。 */
    readonly items: readonly StoreCard[]
    /** 下一页继续使用的键，null 表示结束。 */
    readonly nextAfter: string | null
  }

  /** 空间里的一个对象：store 是空间 id，key 最多 256 个字符。 */
  interface StoreKeyInput {
    readonly store: string
    readonly key: string
  }

  /**
   * 空间里的一个对象：revision 是它自己的版本（写入时作为 baseRevision 交回），删掉之后 deleted 为真、value 为 null，版本保留。
   */
  interface StoreObject {
    /** 空间内的稳定对象键。 */
    readonly key: string
    /** 单对象单调递增版本。 */
    readonly revision: number
    /** 是否为删除墓碑。 */
    readonly deleted: boolean
    /** 对象正文；墓碑为 null。 */
    readonly value: StoreValue
    /** 提交的 ISO 时间。 */
    readonly updatedAt: string
    /** 宿主绑定的写入者。 */
    readonly actor: string
    /** 空间内的持久提交序号。 */
    readonly sequence: number
  }

  /** 读订阅里的消息正文：默认 pending 为真，只读还没 ack 的；after 是消息序号，limit 每页最多 64 条。 */
  interface StoreEventsInput {
    readonly store: string
    readonly after?: number
    readonly limit?: number
    readonly pending?: boolean
  }

  /**
   * 一页消息正文：pending 是还没 ack 的数量；gap 为真说明起点早于保留窗口，更早的消息已经没了，要核对缺口。
   */
  interface StoreEventPage {
    /** 订阅代次。 */
    readonly revision: number
    /** 读取起点。 */
    readonly after: number
    /** 本页扫描终点。 */
    readonly through: number
    /** 当前消息头。 */
    readonly head: number
    /** 未确认处理的消息总数，限保留窗口内。 */
    readonly pending: number
    /** 逐条消息正文。 */
    readonly events: readonly StoreEvent[]
    /** 起点早于保留窗口。 */
    readonly gap: boolean
    /** 是否还有后续消息。 */
    readonly hasMore: boolean
  }

  /** 分页读一份共享材料：offset、limit 按字符算，limit 默认 8000、最多 32000。 */
  interface StoreMaterialInput {
    readonly store: string
    readonly key: string
    readonly offset?: number
    readonly limit?: number
  }

  /** 一页共享材料的正文：从 offset 个字符开始，nextOffset 不是 null 就接着读；chars 是整份材料的字符数，revision 是材料对象的版本。 */
  interface StoreMaterialPage {
    readonly text: string
    readonly offset: number
    readonly nextOffset: number | null
    readonly chars: number
    readonly revision: number
  }

  /** 订阅主题前缀（最多 64 个，每个最多 256 个字符）：after 不给就从当前消息头开始，给 0 可以补读保留窗口里更早的消息；topics 给空数组取消订阅。 */
  interface StoreSubscribeInput {
    readonly store: string
    readonly topics: readonly string[]
    readonly after?: number
  }

  /**
   * 当前的订阅：start 是这一代订阅开始的位置（更早的消息不算待处理），topics 为空表示已取消。
   */
  interface StoreSubscription {
    /** 本代订阅开始位置，待处理计数不包含订阅以前的消息。 */
    readonly start: number
    /** 订阅代次。 */
    readonly revision: number
    /** 已接受模型帧实际扫描到的位置。 */
    readonly after: number
    /** 当前订阅的字面主题前缀；空数组取消。 */
    readonly topics: readonly string[]
  }

  /** 确认已经处理完的消息：ids 1 到 64 个。 */
  interface StoreAckInput {
    readonly store: string
    readonly ids: readonly string[]
  }

  /**
   * 确认过的消息 id；重复确认不会出错。
   */
  interface StoreEventAck {
    /** 已确认的消息身份，重复确认保持幂等。 */
    readonly ids: readonly string[]
  }

  /** 整份替换一个空间的关注集合：keys 精确关注，prefixes 按前缀关注，两者合计最多 64 项，都给空数组就是取消。 */
  interface StoreWatchInput {
    readonly store: string
    readonly keys?: readonly string[]
    readonly prefixes?: readonly string[]
  }

  /**
   * 当前的关注集合：变化按它投递到每一帧的 runtime.stores；相同声明不重置进度。
   */
  interface StoreWatch {
    /** 关注集合的代次。 */
    readonly revision: number
    /** 已确认投递的空间序号。 */
    readonly after: number
    /** 精确关注的键。 */
    readonly keys: readonly string[]
    /** 关注的键前缀。 */
    readonly prefixes: readonly string[]
  }

  /** 发布一条消息：topic 按空间的写前缀授权，value 的 JSON 最多 16 KiB。 */
  interface StorePublishInput {
    readonly store: string
    readonly topic: string
    readonly value: StoreValue
  }

  /**
   * 一条消息：每次发布单独保存，同一主题的不会合并；正文是外部数据。
   */
  interface StoreEvent extends StoreEventCard {
    /** 有界 JSON 正文，大材料通过共享引用传递。 */
    readonly value: StoreValue
  }

  /** 把本会话的一份原文复制成共享材料：ref 必须是本会话的原文，baseRevision 是这个键当前的版本（新键为 0）。 */
  interface StoreShareInput {
    readonly store: string
    readonly key: string
    readonly baseRevision: number
    readonly ref: ContextRef
  }

  /**
   * 创建或整份替换一个对象：baseRevision 是刚读到的 revision，新键为 0；版本不对会冲突，重新读取后再写。value 的 JSON 最多 256 KiB，大材料用 share。
   * event 与对象在同一事务里发布一条消息。
   */
  interface StoreSetInput {
    readonly store: string
    readonly key: string
    readonly baseRevision: number
    readonly value: StoreValue
    readonly event?: { readonly topic: string; readonly value: StoreValue }
  }

  /** 按版本删除一个对象，保留墓碑；空间本身不受影响。 */
  interface StoreRemoveInput {
    readonly store: string
    readonly key: string
    readonly baseRevision: number
  }

  /**
   * 一个能访问的空间与你在它上面的范围：access.read 是能读和订阅的键前缀，access.write 是能写的前缀。
   */
  type StoreEntry = StoreDescriptor & {
    readonly access: { readonly read: readonly string[]; readonly write: readonly string[] }
  }

  /**
   * 对象目录里的一项：只有元数据，正文用 get 读。
   */
  type StoreCard = Omit<StoreObject, 'value'>

  /**
   * 能存进空间的 JSON 值。
   */
  type StoreValue = (
    boolean | number | string | readonly StoreValue[] | { readonly [key: string]: StoreValue }
  ) | null

  /**
   * 一条消息的元数据：sequence 是空间里的消息序号，与对象版本无关。
   */
  interface StoreEventCard {
    /** 宿主分配的稳定消息身份。 */
    readonly id: string
    /** 空间内单调递增的消息序号，与对象版本独立。 */
    readonly sequence: number
    /** 与空间键相同的字面前缀授权范围。 */
    readonly topic: string
    /** 宿主绑定的生产者。 */
    readonly actor: string
    /** 创建时间。 */
    readonly createdAt: string
  }

  /**
   * 原文引用：sessionId 与 id 一起定位一份不可变原文；只能在授权给你的会话范围里读。
   */
  interface ContextRef {
    readonly sessionId: string
    readonly id: string
  }

  /**
   * 一个空间：id 是稳定身份（名字相同也不是同一个空间），archived 为真时不能再读写。
   */
  interface StoreDescriptor {
    /** 不可变标识，名称相同也不代表同一空间。 */
    readonly id: string
    /** 人可读名称。 */
    readonly name: string
    /** 用途说明。 */
    readonly description: string
    /** 创建者会话，由宿主绑定。 */
    readonly owner: string
    /** 创建时间。 */
    readonly createdAt: string
    /** 宿主已归档时不再允许读写。 */
    readonly archived: boolean
  }
}
