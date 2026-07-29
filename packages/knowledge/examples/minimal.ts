import {
  DefaultKnowledgeRuntime,
  type KnowledgeRuntimeProviders,
} from '@velaros-ai/knowledge'

declare const providers: KnowledgeRuntimeProviders

const knowledge = new DefaultKnowledgeRuntime(providers)

await knowledge.warmup()
await knowledge.domain.ensureWorkspaceSynced('/srv/project')
const results = await knowledge.domain.searchKnowledge('认证流程', {
  workspaceRoot: '/srv/project',
})
knowledge.close()

console.info(results)
