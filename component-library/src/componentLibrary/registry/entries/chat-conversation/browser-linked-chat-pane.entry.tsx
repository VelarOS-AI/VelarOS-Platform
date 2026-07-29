import { BrowserLinkedChatPaneExample } from '@catalog/examples/ChatExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.chatConversation,
  entryOrder: 30,
  entry: {
    id: 'browser-linked-chat-pane',
    name: 'Browser Linked Chat Pane',
    layer: 'Feature',
    status: 'ready',
    domain: 'Chat / Browser',
    source: 'component-library adapters (Desktop host reference)',
    origin: 'components/chat/browser',
    exampleMode: 'fixture',
    usage:
      'Use when browser mode needs a docked chat pane that shares the current conversation surface.',
    avoid:
      'Do not open the popout window from component-library examples; keep browser fixtures in-process.',
    examples: [
      {
        id: 'browser-linked-chat-pane-fixture',
        label: 'Fixture: browser side chat shell',
        node: <BrowserLinkedChatPaneExample />,
      },
    ],
  },
})
