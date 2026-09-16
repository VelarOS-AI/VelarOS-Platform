import {
  createAgentExecutionStack,
  type AgentModelRetryPolicy,
  type AgentRunLifecycle,
} from '@velaros-ai/agent'
import { agentToolContracts, fileContextRegistry } from '@velaros-ai/agent/tool-contract'
import { createModelRequestClient } from '@velaros-ai/model'
import { languageQueries, type LanguageReadPort, type LanguageToolContext } from '@velaros-ai/development'
import { mountMemoryAdapter, type MountMemoryAdapterInput } from '@velaros-ai/memory'
import { ComputerOperationMetadata, ComputerToolNames, type ComputerOperation } from '@velaros-ai/computer/contracts'
import { projectFileContext, type ProjectFileContextCarrier } from '@velaros-ai/project'

declare const projectContext: ProjectFileContextCarrier
if (projectFileContext.register(projectContext)) void fileContextRegistry.for(projectContext)?.currentViews()

declare const source: LanguageReadPort
const languageContext: LanguageToolContext = {
  abortSignal: new AbortController().signal,
  project: {
    getRootPath: () => '/workspace/example',
    kernel: async () => source,
  },
}
void languageQueries.run({ action: 'find_symbols' }, languageContext)

declare const backend: NonNullable<MountMemoryAdapterInput['backend']>
declare const config: MountMemoryAdapterInput['config']
declare const hostContext: MountMemoryAdapterInput['hostContext']
const standalone = mountMemoryAdapter({ backend, config, hostContext })
void standalone.service

const retry: AgentModelRetryPolicy = {
 allowPartialContinuation: false,
 onFailure: () => null,
}
const lifecycle: AgentRunLifecycle<object> = {
 beforeTurn: async ({ abortSignal }: { abortSignal: AbortSignal }) => { abortSignal.throwIfAborted() },
 onTurnSettled: async ({ history }: { history: readonly unknown[] }) => (history.length ? 'stop' : 'continue'),
}
const operation: ComputerOperation = ComputerToolNames.screenshot
void [createAgentExecutionStack, createModelRequestClient, lifecycle, retry,
 agentToolContracts.discoveryDescriptors, agentToolContracts.readSchemaDiscoveryNames({names:['project:read']}), ComputerOperationMetadata[operation]]
