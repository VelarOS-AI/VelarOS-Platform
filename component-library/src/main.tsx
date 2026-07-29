import { type ReactElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ComponentLibraryPage from '@catalog/ComponentLibraryPage'
import { CatalogI18nProvider } from '@catalog/i18n'

import {
  ChatToolRenderCapabilitiesProvider,
  type ConversationActionPort,
  ConversationActionPortProvider,
  type ConversationBlockHooks,
  ConversationBlockHooksProvider,
  emptyChatToolRenderCapabilities,
} from '@velaros-ai/ui/conversation'
import {
  ConversationComposerPortProvider,
  emptyConversationComposerPort,
} from '@velaros-ai/ui/conversation/composer'

import './catalog.css'

const previewBlockHooks: ConversationBlockHooks = {
  useAutoTranslateThinkingEnabled: () => false,
  useMessageActionView: () => ({
    actionItems: [],
    actionRows: [],
    formatPathForDisplay: (path) => path,
    hasActionItems: false,
    openPathInLight: async () => undefined,
  }),
}

const previewActionPort: ConversationActionPort = {
  getGoalLifecycle: async () => ({ goal: null, ok: true }),
  provideExecutionGuidance: async () => undefined,
  updateGoalLifecycle: async () => ({ goal: null, ok: true }),
}

function CatalogRuntime(): ReactElement {
  return (
    <CatalogI18nProvider>
      <ConversationBlockHooksProvider value={previewBlockHooks}>
        <ConversationActionPortProvider value={previewActionPort}>
          <ChatToolRenderCapabilitiesProvider value={emptyChatToolRenderCapabilities}>
            <ConversationComposerPortProvider value={emptyConversationComposerPort}>
              <ComponentLibraryPage />
            </ConversationComposerPortProvider>
          </ChatToolRenderCapabilitiesProvider>
        </ConversationActionPortProvider>
      </ConversationBlockHooksProvider>
    </CatalogI18nProvider>
  )
}

const rootElement = document.querySelector('#root')
if (!rootElement) throw new Error('Missing component library root element')

createRoot(rootElement).render(
  <StrictMode>
    <CatalogRuntime />
  </StrictMode>
)
