import {
  ChatConversationRuntimeStatesExample,
  ChatConversationSkeletonExample,
  ChatInteractionCardsExample,
} from '@catalog/examples/ChatExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 20,
  entry: {
    id: 'chat-runtime-states',
    name: 'Chat Runtime States / Interaction Cards',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat Conversation',
    source: '@velaros-ai/ui/conversation',
    origin: 'components/chat/conversation',
    exampleMode: 'fixture',
    usage: 'Use to review runtime notices and loading states shown around the conversation stream.',
    avoid: 'Do not wire component-library examples to live runtime callbacks or active sessions.',
    examples: [
      {
        id: 'chat-runtime-notices',
        label: 'Fixture: awaiting input and failure notices',
        node: <ChatConversationRuntimeStatesExample />,
      },
      {
        id: 'chat-interaction-cards',
        label: 'Fixture: input and confirmation cards',
        node: <ChatInteractionCardsExample />,
      },
      {
        id: 'chat-runtime-skeleton',
        label: 'Fixture: side-pane loading skeleton',
        node: <ChatConversationSkeletonExample />,
      },
    ],
  },
})
