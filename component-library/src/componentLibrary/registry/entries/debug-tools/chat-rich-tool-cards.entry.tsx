import {
  ArtifactToolCardExample,
  GitCommitsToolCardExample,
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
    name: 'Rich Tool Cards (git / memory / artifact / search / webread)',
    layer: 'Feature',
    status: 'ready',
    domain: 'Tool result',
    source: '@velaros-ai/conversation-ui',
    origin: 'packages/conversation-ui/src/tool-render/richOutput',
    exampleMode: 'fixture',
    usage:
      '富输出工具卡共用 RichToolOutputCard 壳(collapsible),按 toolName 路由:web_search / web_read / produce_artifact / search_memories / get_git_commits。',
    avoid: '不要为富结果另起自绘卡壳;新富工具接进 RichToolOutputCard,tone/badge 走既有约定。',
    examples: [
      { id: 'rich-artifact', label: 'Artifact(produce_artifact)· success(真实收割)/running/error', node: <ArtifactToolCardExample /> },
      { id: 'rich-git', label: 'Git Commits(get_git_commits)· success/empty/running · 手编 fixture', node: <GitCommitsToolCardExample /> },
      { id: 'rich-memory', label: 'Memory Recall(search_memories)· hits/empty/running · 手编 fixture', node: <MemoryRecallToolCardExample /> },
      { id: 'rich-search', label: 'Web Search(web_search)· answer+results/empty · 手编 fixture', node: <SearchResultToolCardExample /> },
      { id: 'rich-webread', label: 'Web Read(web_read)· success/tool-error/running · 手编 fixture', node: <WebReadToolCardExample /> },
    ],
  },
})
