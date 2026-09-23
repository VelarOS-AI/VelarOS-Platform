/**
 * 可持久化的 JSON 值；运行实例和能力句柄由各自宿主管理。
 * @AgentView
 * 能存进空间的 JSON 值。
 */
export type StoreValue = Nullable<boolean | number | string | readonly StoreValue[] | {readonly [key:string]:StoreValue}>
/**
 * 当前对象快照；删除保留版本墓碑，防止旧写入覆盖重新创建的对象。
 * @AgentView
 * 空间里的一个对象：revision 是它自己的版本（写入时作为 baseRevision 交回），删掉之后 deleted 为真、value 为 null，版本保留。
 */
export interface StoreObject {
 /** 空间内的稳定对象键。 */
 readonly key:string
 /** 单对象单调递增版本。 */
 readonly revision:number
 /** 是否为删除墓碑。 */
 readonly deleted:boolean
 /** 对象正文；墓碑为 null。 */
 readonly value:StoreValue
 /** 提交的 ISO 时间。 */
 readonly updatedAt:string
 /** 宿主绑定的写入者。 */
 readonly actor:string
 /** 空间内的持久提交序号。 */
 readonly sequence:number
}
/**
 * 对象目录只返回元数据。
 * @AgentView
 * 对象目录里的一项：只有元数据，正文用 get 读。
 */
export type StoreCard = Omit<StoreObject,'value'>
/**
 * 按键排序的有界目录页。
 * @AgentView
 * 按键排序的一页对象目录；nextAfter 不是 null 就把它当 after 接着翻。
 */
export interface StorePage {
 /** 当前页对象。 */
 readonly items:readonly StoreCard[]
 /** 下一页继续使用的键，null 表示结束。 */
 readonly nextAfter:Nullable<string>
}
/** 宿主签发的原子写入请求。 */
export interface StoreMutation {
 /** 与对象更新同一事务发布的可选消息。 */
 readonly event?:{readonly topic:string;readonly value:StoreValue}
 /** 持久空间标识。 */
 readonly store:string
 /** 对象键。 */
 readonly key:string
 /** 预期当前版本；新键为 0。 */
 readonly baseRevision:number
 /** 替换后的完整 JSON 值。 */
 readonly value?:StoreValue
 /** 写入删除墓碑。 */
 readonly remove?:boolean
 /** 可信会话身份。 */
 readonly actor:string
 /** 真实 Kernel 调用身份，重试同一写入时保持不变。 */
 readonly operationId:string
}
/**
 * 持久关注声明；相同声明保持消费位置。
 * @AgentView
 * 当前的关注集合：变化按它投递到每一帧的 runtime.stores；相同声明不重置进度。
 */
export interface StoreWatch {
 /** 关注集合的代次。 */
 readonly revision:number
 /** 已确认投递的空间序号。 */
 readonly after:number
 /** 精确关注的键。 */
 readonly keys:readonly string[]
 /** 关注的键前缀。 */
 readonly prefixes:readonly string[]
}
/** 状态变更仅包含位置与版本，正文仍由 get 读取。 */
export type StoreChange = StoreCard & {readonly type:'store.changed'}
/** 当前关注范围内可投递的一页变化。 */
export interface StoreChanges {
 /** 订阅代次，用于拒绝旧帧确认新的订阅。 */
 readonly revision:number
 /** 本页起始消费位置。 */
 readonly after:number
 /** 本页实际覆盖的扫描位置。 */
 readonly through:number
 /** 读取时的空间最新序号。 */
 readonly head:number
 /** 同一对象在本页的变化合并为最新一条。 */
 readonly events:readonly StoreChange[]
 /** 保留窗口外存在缺口，消费者需要重新读取关注对象。 */
 readonly gap:boolean
 /** 是否还有待扫描变化。 */
 readonly hasMore:boolean
}
/**
 * 独立持久空间的目录记录，正文通过对象操作读取。
 * @AgentView
 * 一个空间：id 是稳定身份（名字相同也不是同一个空间），archived 为真时不能再读写。
 */
export interface StoreDescriptor {
 /** 不可变标识，名称相同也不代表同一空间。 */
 readonly id:string
 /** 人可读名称。 */
 readonly name:string
 /** 用途说明。 */
 readonly description:string
 /** 创建者会话，由宿主绑定。 */
 readonly owner:string
 /** 创建时间。 */
 readonly createdAt:string
 /** 宿主已归档时不再允许读写。 */
 readonly archived:boolean
}
/** 宿主签发的空间创建请求。 */
export interface StoreCreate {
 /** 宿主固定的租户或项目边界。 */
 readonly scope:string
 /** 可信创建者。 */
 readonly owner:string
 /** 空间名称。 */
 readonly name:string
 /** 简短说明。 */
 readonly description?:string
 /** 原调用身份，用于恢复创建结果。 */
 readonly operationId:string
}
/** 只包含获准空间的目录页。 */
export interface StoreDirectory {
 /** 当前页记录。 */
 readonly items:readonly StoreDescriptor[]
 /** 下一页游标。 */
 readonly nextAfter:Nullable<string>
}

/**
 * 自动上下文只投递消息元数据。
 * @AgentView
 * 一条消息的元数据：sequence 是空间里的消息序号，与对象版本无关。
 */
export interface StoreEventCard {
 /** 宿主分配的稳定消息身份。 */
 readonly id:string
 /** 空间内单调递增的消息序号，与对象版本独立。 */
 readonly sequence:number
 /** 与空间键相同的字面前缀授权范围。 */
 readonly topic:string
 /** 宿主绑定的生产者。 */
 readonly actor:string
 /** 创建时间。 */
 readonly createdAt:string
}
/**
 * 按空间顺序保存的独立消息；相同主题不会合并。
 * @AgentView
 * 一条消息：每次发布单独保存，同一主题的不会合并；正文是外部数据。
 */
export interface StoreEvent extends StoreEventCard {
 /** 有界 JSON 正文，大材料通过共享引用传递。 */
 readonly value:StoreValue
}
/** 持久消息提交，与对象提交共用调用身份和事务。 */
export interface StorePublish {
 /** 获准的空间。 */
 readonly store:string
 /** 主题。 */
 readonly topic:string
 /** JSON 正文。 */
 readonly value:StoreValue
 /** 可信生产者。 */
 readonly actor:string
 /** 原始调用身份，用于核对而非重放脚本。 */
 readonly operationId:string
}
/**
 * 持久订阅；投递游标与逐条处理确认独立。
 * @AgentView
 * 当前的订阅：start 是这一代订阅开始的位置（更早的消息不算待处理），topics 为空表示已取消。
 */
export interface StoreSubscription {
 /** 本代订阅开始位置，待处理计数不包含订阅以前的消息。 */
 readonly start:number
 /** 订阅代次。 */
 readonly revision:number
 /** 已接受模型帧实际扫描到的位置。 */
 readonly after:number
 /** 当前订阅的字面主题前缀；空数组取消。 */
 readonly topics:readonly string[]
}
/**
 * 消息读取页，窗口外的数据缺口必须明确反馈。
 * @AgentView
 * 一页消息正文：pending 是还没 ack 的数量；gap 为真说明起点早于保留窗口，更早的消息已经没了，要核对缺口。
 */
export interface StoreEventPage {
 /** 订阅代次。 */
 readonly revision:number
 /** 读取起点。 */
 readonly after:number
 /** 本页扫描终点。 */
 readonly through:number
 /** 当前消息头。 */
 readonly head:number
 /** 未确认处理的消息总数，限保留窗口内。 */
 readonly pending:number
 /** 逐条消息正文。 */
 readonly events:readonly StoreEvent[]
 /** 起点早于保留窗口。 */
 readonly gap:boolean
 /** 是否还有后续消息。 */
 readonly hasMore:boolean
}
/**
 * 逐条处理确认的可恢复回执。
 * @AgentView
 * 确认过的消息 id；重复确认不会出错。
 */
export interface StoreEventAck {
 /** 已确认的消息身份，重复确认保持幂等。 */
 readonly ids:readonly string[]
}
