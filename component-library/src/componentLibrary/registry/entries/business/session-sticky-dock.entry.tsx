import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 30,
  entry: {
    id: 'session-sticky-dock',
    name: 'Session Sticky Dock',
    layer: 'Business',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/product/layout/SessionStickyDock',
    exampleMode: 'fixture',
    usage: '用于在对话顶部固定一组可插入的会话级业务卡片，并支持整体折叠。',
    avoid: '不要把 dock 绑定到某一种卡片；通过 item view model 传入可插入的卡片内容；无障碍条标签经 barLabel 由宿主注入。',
    examples: businessComponentExamples['session-sticky-dock'] ?? [],
    apiComponents: ['SessionStickyDock'],
  },
})
