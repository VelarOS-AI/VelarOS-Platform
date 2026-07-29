import type { ComponentLibraryEntryRegistration } from './componentLibraryRegistryTypes'

type ComponentLibrarySectionBinding = Pick<
  ComponentLibraryEntryRegistration,
  'sectionId' | 'sectionTitle' | 'sectionOrder'
>

export const componentLibraryRegistrySections = {
  foundation: {
    sectionId: 'foundation',
    sectionTitle: 'Foundation',
    sectionOrder: 0,
  },
  overlays: {
    sectionId: 'overlays',
    sectionTitle: 'Overlays',
    sectionOrder: 10,
  },
  businessCandidates: {
    sectionId: 'business-candidates',
    sectionTitle: 'Business Components',
    sectionOrder: 20,
  },
  shell: {
    sectionId: 'shell',
    sectionTitle: 'Shell',
    sectionOrder: 30,
  },
  chatConversation: {
    sectionId: 'chat-conversation',
    sectionTitle: 'Chat Conversation',
    sectionOrder: 40,
  },
  debugTools: {
    sectionId: 'debug-tools',
    sectionTitle: 'Debug & Tools',
    sectionOrder: 50,
  },
  tokens: {
    sectionId: 'tokens',
    sectionTitle: 'Tokens',
    sectionOrder: 70,
  },
  visualDomains: {
    sectionId: 'visual-domains',
    sectionTitle: 'Visual Domains',
    sectionOrder: 80,
  },
} satisfies Record<string, ComponentLibrarySectionBinding>
