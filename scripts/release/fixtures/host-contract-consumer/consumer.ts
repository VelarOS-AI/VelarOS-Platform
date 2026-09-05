import { createAgentExecutionStack, type AgentModelRetryPolicy, type AgentRunLifecycle } from '@velaros-ai/agent'
import { ToolContractDiscoveryDescriptors, readToolSchemaDiscoveryNames } from '@velaros-ai/agent/tool-contract'
import { ModelRequestClient } from '@velaros-ai/model'
import { executeProjectCodeLanguageQuery, type LanguageReadPort, type LanguageToolContext } from '@velaros-ai/development/runtime'
import { mountMemoryAdapter, type MountMemoryAdapterInput } from '@velaros-ai/memory/adapter-kernel'
import { ComputerOperationMetadata, ComputerToolOperations, type ComputerOperation } from '@velaros-ai/computer/contracts'

declare const source: LanguageReadPort
const languageContext: LanguageToolContext = {
  abortSignal: new AbortController().signal,
  project: {
    getRootPath: () => '/workspace/example',
    runInDirectory: async (_path, action) => action(),
    kernel: async () => source,
  },
}
void executeProjectCodeLanguageQuery({ action: 'find_symbols' }, languageContext)

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
 beforeTurn: async ({abortSignal}) => {abortSignal.throwIfAborted()},
 onTurnSettled: async ({history}) => history.length ? 'stop' : 'continue',
}
const operation: ComputerOperation = ComputerToolOperations['computer:screenshot']
void [createAgentExecutionStack, ModelRequestClient, lifecycle, retry,
 ToolContractDiscoveryDescriptors, readToolSchemaDiscoveryNames({names:['project:read']}), ComputerOperationMetadata[operation]]
