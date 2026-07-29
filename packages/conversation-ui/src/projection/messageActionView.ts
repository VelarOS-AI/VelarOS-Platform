/**
 * `MessageActionView` — 消息动作行渲染件（`MessageActionList` / `MessageActionRow`，批 5 步 4 blocks
 * 原子）消费的 **viewmodel 输出投影**。
 *
 * 宿主 hook `useChatMessageActionViewModel` 触达 rendererIpc（open/reveal 路径）+ `@shared` 默认编辑器
 * 常量，留宿主；包只声明其输出形状。`ConversationActionItem` 镜像宿主 `ChatActionItem`（扁平、零 core
 * 依赖），因此宿主 hook 返回与本投影**结构可赋值**——desktop 边界 `toMessageActionView` 零丢失映射。
 * blocks 原子（步 4）迁入包时在此边界完成消费収口。
 */

export interface ConversationActionItem {
  key: string
  kind: 'file'
  action:
    | 'created'
    | 'written'
    | 'modified'
    | 'deleted'
    | 'moved'
    | 'opened'
    | 'revealed'
    | 'log'
    | 'file'
  title: string
  detail?: string
  openPath?: string
}

export interface ConversationMessageActionRow {
  item: ConversationActionItem
  displayTitle: string
  onClick?: (item: ConversationActionItem) => void
  onReveal?: (item: ConversationActionItem) => void
}

export interface MessageActionView {
  actionItems: ConversationActionItem[]
  actionRows: ConversationMessageActionRow[]
  formatPathForDisplay: (path: string) => string
  hasActionItems: boolean
  openPathInLight: (path: string) => Promise<void>
}
