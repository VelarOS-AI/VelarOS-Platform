import { ChatConversationMessageStatesExample } from '@catalog/examples/ChatExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 10,
  entry: {
    id: 'chat-message-bubble',
    name: 'Chat Message Bubble',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/ui/conversation',
    origin: 'packages/ui/src/conversation/blocks',
    exampleMode: 'fixture',
    usage:
      'Use as the visible contract for user and assistant message states: attachments, tool activity, streaming and inline status.',
    avoid:
      'Do not attach real open/reveal paths or installation actions in component-library fixtures.',
    examples: [
      {
        id: 'chat-message-bubble-states',
        label: 'Fixture: user, completed assistant and streaming assistant',
        node: <ChatConversationMessageStatesExample />,
      },
    ],
  },
})
