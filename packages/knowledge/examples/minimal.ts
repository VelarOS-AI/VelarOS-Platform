import {
  createKnowledgeRuntime,
  type KnowledgeRuntimeProviders,
} from '../src/index'

declare const providers: KnowledgeRuntimeProviders

const knowledge = createKnowledgeRuntime(providers)

await knowledge.warmup()
await knowledge.knowledgeDomainService.ensureWorkspaceSynced('/srv/project')
const results = await knowledge.knowledgeDomainService.searchKnowledge('认证流程', {
  workspaceRoot: '/srv/project',
})
knowledge.close()

console.info(results)
