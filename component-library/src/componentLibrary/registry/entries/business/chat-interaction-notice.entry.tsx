import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 31,
  entry: {
    id: 'chat-interaction-notice',
    name: 'Chat Interaction Notice',
    layer: 'Business',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/product/display/ChatInteractionNotice',
    exampleMode: 'fixture',
    usage: '用于对话内轻量通知条（运行中、警告、错误），不含 runtime 推导逻辑。',
    avoid: '不要在此组件内绑定 ChatRuntimeState；由上层传入 title / description / tone。',
    examples: businessComponentExamples['chat-interaction-notice'] ?? [],
    apiComponents: ['ChatInteractionNotice'],
  },
})
