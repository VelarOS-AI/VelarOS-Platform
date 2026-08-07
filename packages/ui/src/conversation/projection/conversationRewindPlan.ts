/**
 * 回溯的文件档：这次回溯**能不能**、以及**该不该**动文件。
 *
 * 会话壳不认识空间枚举，也不认识检查点——「系统工作区没有文件轴」「这个项目没有 git 快照」
 * 这类判断全部由宿主做完再投影下来（与 `ConversationView.supportsProjectFiles` 同一条分层原则）。
 * 弹窗只按本档分叉渲染，永远不自己推断。
 */
export type ConversationRewindFilePlan =
  /** 该空间没有文件轴（系统 / 浏览器工作区）——弹窗一个字都不该提文件。 */
  | { kind: 'out-of-scope' }
  /** 有文件轴，但被移除的这几轮没有改过文件——同样不该问。 */
  | { kind: 'nothing-to-restore' }
  /** 改过文件，但拿不到该时点的快照（项目不是 git 仓库 / 快照已被淘汰）——只能如实说不能回。 */
  | { kind: 'no-snapshot'; changedFileCount: number }
  /** 可以回退：把 `rootCount` 个项目根整体还原到该时点。 */
  | { kind: 'restorable'; changedFileCount: number; rootCount: number }

/**
 * 回溯预览：宿主在**打开确认框那一刻**同步算出的「这次回溯会发生什么」。
 *
 * 逐条消息预算这个模型太贵，所以走 `getRewindPlan(messageId)` 惰性回调而不是 prop。
 */
export interface ConversationRewindPlan {
  /** 会被移除的消息条数（含目标消息本身）。 */
  removedMessageCount: number
  /** 会被移除的用户轮次数。 */
  removedTurnCount: number
  /** 被移除轮次里的工具调用次数。0 = 纯对话，世界没被动过，回溯是干净的。 */
  toolCallCount: number
  files: ConversationRewindFilePlan
}
