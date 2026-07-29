import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 32,
  entry: {
    id: 'interaction-suggestion-card',
    name: 'Interaction Suggestion Card',
    layer: 'Business',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/product/layout/InteractionSuggestionCard',
    exampleMode: 'fixture',
    usage:
      '用于对话内 ActionCard 建议卡（工具安装、工作区切换、记忆保存等）的统一壳层，默认附加 velar-action-card-flat。',
    avoid: '不要把 IPC 或 block 解析逻辑放进此壳层；只负责 ActionCard 布局与 class 约定。',
    examples: businessComponentExamples['interaction-suggestion-card'] ?? [],
    apiComponents: ['InteractionSuggestionCard'],
  },
})
