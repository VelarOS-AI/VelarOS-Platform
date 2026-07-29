import { ChatGuidanceQueueExample } from '@catalog/examples/ChatExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 5,
  entry: {
    id: 'chat-guidance-queue',
    name: 'Chat Guidance Queue',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat Composer',
    source: '@velaros-ai/ui/conversation/composer',
    origin: 'packages/ui/src/conversation/composer',
    exampleMode: 'fixture',
    usage:
      'Use to review queued guidance ordering, one-line truncation, immediate guidance, return-to-input editing, and deletion.',
    avoid:
      'Do not edit queue content inline; the edit action removes the item from the queue and restores it to the composer.',
    examples: [
      {
        id: 'chat-guidance-queue-fixture',
        label: 'Fixture: sortable guidance queue',
        node: <ChatGuidanceQueueExample />,
      },
    ],
  },
})
