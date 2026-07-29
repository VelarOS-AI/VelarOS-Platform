import {
  AskUserCarouselExample,
  UserActionCardActionExample,
  UserActionCardDisabledExample,
  UserActionCardFormExample,
} from '@catalog/examples/ChatUserActionCardExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 30,
  entry: {
    id: 'chat-user-action-cards',
    name: 'User Action Cards (approval / form / wizard)',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/ui/conversation',
    origin: 'packages/ui/src/conversation/cards',
    exampleMode: 'fixture',
    usage:
      'user-action-card 块的两种呈现:UserActionCard(批准 / 确认 / 启用能力 / 表单)与 AskUserCarousel(wizard 逐题分页)。tone 与 icon 均从 card 字段派生的封闭枚举。',
    avoid:
      '不要把 UserActionCard 绑到活跃会话的 onResolve 回调或真实 sessionId 消费态;图鉴里只走本地 onActionComplete。',
    examples: [
      { id: 'user-action-actions', label: 'UserActionCard · 批准/确认/启用能力 · 手编 fixture', node: <UserActionCardActionExample /> },
      { id: 'user-action-forms', label: 'UserActionCard.form · 选择表单/文本输入 · 手编 fixture', node: <UserActionCardFormExample /> },
      { id: 'user-action-disabled', label: 'blocking 卡失活态(disabled)· 手编 fixture', node: <UserActionCardDisabledExample /> },
      { id: 'user-action-wizard', label: 'AskUserCarousel · wizard 分页(真实 ask_user 收割)', node: <AskUserCarouselExample /> },
    ],
  },
})
