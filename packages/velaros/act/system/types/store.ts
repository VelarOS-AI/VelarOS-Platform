import type {
  ContextRef,
  StoreChanges,
  StoreDescriptor,
  StoreEventCard,
  StoreEventPage,
  StoreValue,
} from '@velaros-ai/context'
/** 宿主给会话的一个空间授权，子任务继承父会话时也按它传下去。 */
export interface StoreGrant {
  /** 已存在的空间标识。 */
  readonly store: string
  /** 可读和订阅的键前缀。 */
  readonly read: readonly string[]
  /** 可写前缀，必须属于可读范围。 */
  readonly write: readonly string[]
}
/** 宿主固定的存储边界及可用空间。 */
export interface StoreConfiguration {
  /** 租户或项目边界，模型不能修改。 */
  readonly scope: string
  /** 是否允许创建，主线默认允许。 */
  readonly create?: boolean
  /** 其他创建者的空间授权。 */
  readonly grants?: readonly StoreGrant[]
}
/**
 * 目录中的实际访问范围。
 * @AgentView
 * 一个能访问的空间与你在它上面的范围：access.read 是能读和订阅的键前缀，access.write 是能写的前缀。
 */
export type StoreEntry = StoreDescriptor & {
  readonly access: { readonly read: readonly string[]; readonly write: readonly string[] }
}
/** @AgentView 空间目录的一页；nextAfter 不是 null 就把它当 after 接着翻。 */
export interface StoreEntryPage {
  readonly items: readonly StoreEntry[]
  readonly nextAfter: Nullable<string>
}
/** @AgentView 一页共享材料的正文：从 offset 个字符开始，nextOffset 不是 null 就接着读；chars 是整份材料的字符数，revision 是材料对象的版本。 */
export interface StoreMaterialPage {
  readonly text: string
  readonly offset: number
  readonly nextOffset: Nullable<number>
  readonly chars: number
  readonly revision: number
}

/** @AgentView 翻空间目录：active 为真只列当前任务在用的空间；limit 每页最多 64 个。 */
export interface StoreListInput {
  readonly after?: string
  readonly limit?: number
  readonly active?: boolean
}
/** @AgentView 翻一个空间里自己能读的对象目录：prefix 限定键前缀（最多 256 个字符），limit 每页最多 64 项。 */
export interface StoreKeysInput {
  readonly store: string
  readonly prefix?: string
  readonly after?: string
  readonly limit?: number
}
/** @AgentView 空间里的一个对象：store 是空间 id，key 最多 256 个字符。 */
export interface StoreKeyInput {
  readonly store: string
  readonly key: string
}
/** @AgentView 读订阅里的消息正文：默认 pending 为真，只读还没 ack 的；after 是消息序号，limit 每页最多 64 条。 */
export interface StoreEventsInput {
  readonly store: string
  readonly after?: number
  readonly limit?: number
  readonly pending?: boolean
}
/** @AgentView 分页读一份共享材料：offset、limit 按字符算，limit 默认 8000、最多 32000。 */
export interface StoreMaterialInput {
  readonly store: string
  readonly key: string
  readonly offset?: number
  readonly limit?: number
}
/** @AgentView 订阅主题前缀（最多 64 个，每个最多 256 个字符）：after 不给就从当前消息头开始，给 0 可以补读保留窗口里更早的消息；topics 给空数组取消订阅。 */
export interface StoreSubscribeInput {
  readonly store: string
  readonly topics: readonly string[]
  readonly after?: number
}
/** @AgentView 确认已经处理完的消息：ids 1 到 64 个。 */
export interface StoreAckInput {
  readonly store: string
  readonly ids: readonly string[]
}
/** @AgentView 整份替换一个空间的关注集合：keys 精确关注，prefixes 按前缀关注，两者合计最多 64 项，都给空数组就是取消。 */
export interface StoreWatchInput {
  readonly store: string
  readonly keys?: readonly string[]
  readonly prefixes?: readonly string[]
}
/** @AgentView 发布一条消息：topic 按空间的写前缀授权，value 的 JSON 最多 16 KiB。 */
export interface StorePublishInput {
  readonly store: string
  readonly topic: string
  readonly value: StoreValue
}
/** @AgentView 把本会话的一份原文复制成共享材料：ref 必须是本会话的原文，baseRevision 是这个键当前的版本（新键为 0）。 */
export interface StoreShareInput {
  readonly store: string
  readonly key: string
  readonly baseRevision: number
  readonly ref: ContextRef
}
/**
 * @AgentView
 * 创建或整份替换一个对象：baseRevision 是刚读到的 revision，新键为 0；版本不对会冲突，重新读取后再写。value 的 JSON 最多 256 KiB，大材料用 share。
 * event 与对象在同一事务里发布一条消息。
 */
export interface StoreSetInput {
  readonly store: string
  readonly key: string
  readonly baseRevision: number
  readonly value: StoreValue
  readonly event?: { readonly topic: string; readonly value: StoreValue }
}
/** @AgentView 按版本删除一个对象，保留墓碑；空间本身不受影响。 */
export interface StoreRemoveInput {
  readonly store: string
  readonly key: string
  readonly baseRevision: number
}
/** @AgentView 创建一个独立的持久空间：name 最多 128 个字符（名字不是授权），description 最多 512 个字符。 */
export interface StoreCreateInput {
  readonly name: string
  readonly description?: string
}
/** 多空间共用一份交付预算，正文仍按需读取。 */
export interface StoreFrame {
  /** 当前任务的稳定空间引用；正文按需读取，省略量明确反馈。 */
  readonly active: {
    /** 逻辑任务身份，尚未开始时为空。 */
    readonly taskId: Nullable<string>
    /** 本帧可容纳的当前任务引用。 */
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly description: string
      readonly descriptionTruncated: boolean
    }>
    /** 当前授权范围内的活跃空间总数。 */
    readonly total: number
    /** 未放入本帧的引用数，通过 list({active:true}) 分页读取。 */
    readonly omitted: number
  }
  /** 获配目录的第一页，完整列表通过 store.list 获取。 */
  readonly items: readonly StoreEntry[]
  /** 目录后续页游标。 */
  readonly nextAfter: Nullable<string>
  /** 实际交付的变化及各自的确认位置。 */
  /** 独立消息元数据和待处理数量；正文由 events 显式读取。 */
  readonly messages: ReadonlyArray<
    Omit<StoreEventPage, 'events'> & {
      readonly store: string
      readonly events: readonly StoreEventCard[]
    }
  >
  readonly changes: ReadonlyArray<StoreChanges & { readonly store: string }>
}
