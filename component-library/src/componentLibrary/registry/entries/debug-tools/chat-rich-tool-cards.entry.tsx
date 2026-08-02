import {
  ArtifactToolCardExample,
  MemoryRecallToolCardExample,
  SearchResultToolCardExample,
  WebReadToolCardExample,
} from '@catalog/examples/ChatRichToolCardExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.debugTools,
  entryOrder: 30,
  entry: {
    id: 'chat-rich-tool-cards',
    name: 'Rich Tool Cards (memory / artifact / search / webread)',
    layer: 'Feature',
    status: 'ready',
    domain: 'Tool result',
    source: '@velaros-ai/ui/conversation',
    origin: 'packages/ui/src/conversation/tool-render/richOutput',
    exampleMode: 'fixture',
    usage:
      '富输出工具卡共用 RichToolOutputCard 壳(collapsible),按 toolName 路由:web:search / web:read / artifact:produce / memory:search。',
    avoid: '不要为富结果另起自绘卡壳;新富工具接进 RichToolOutputCard,tone/badge 走既有约定。',
    examples: [
      { id: 'rich-artifact', label: 'Artifact(artifact:produce)· success(真实收割)/running/error', node: <ArtifactToolCardExample /> },
      { id: 'rich-memory', label: 'Memory Recall(memory:search)· hits/empty/running · 手编 fixture', node: <MemoryRecallToolCardExample /> },
      { id: 'rich-search', label: 'Web Search(web:search)· answer+results/empty · 手编 fixture', node: <SearchResultToolCardExample /> },
      { id: 'rich-webread', label: 'Web Read(web:read)· success/tool-error/running · 手编 fixture', node: <WebReadToolCardExample /> },
    ],
  },
})
