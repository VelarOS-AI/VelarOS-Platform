import { ChatInputExample } from '@catalog/examples/ChatExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 0,
  entry: {
    id: 'chat-input',
    name: 'Chat Input',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat Composer',
    source: '@velaros-ai/conversation-ui/composer',
    origin: 'packages/conversation-ui/src/composer',
    exampleMode: 'fixture',
    usage: 'Use as the shared composer input surface for chat and dev console panes.',
    avoid:
      'Do not build feature-local composer controls; pass slots and prompt options into ChatInput.',
    examples: [
      {
        id: 'chat-input-fixture',
        label: 'Fixture: composer input',
        node: <ChatInputExample />,
      },
    ],
  },
})
