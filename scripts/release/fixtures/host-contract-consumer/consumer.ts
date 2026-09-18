import {
  createAgentExecutionStack,
  type AgentModelRetryPolicy,
  type AgentRunLifecycle,
} from '@velaros-ai/agent'
import { agentToolContracts } from '@velaros-ai/agent/tool-contract'
import { createModelRequestClient } from '@velaros-ai/model'
import { languageQueries, type LanguageReadPort, type LanguageToolContext } from '@velaros-ai/development'
import { ComputerInputLimits, type ComputerPoint } from '@velaros-ai/velar/computer/contracts'
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { createProjectSpace, type ProjectCallContext } from '@velaros-ai/project'
import { FileLimits } from '@velaros-ai/velar/files/contracts'
import { officeOperations, type OfficeOperationContext } from '@velaros-ai/velar/office'
import type { OfficeEnvironmentInspection, OfficeWritten } from '@velaros-ai/velar/office/contracts'
import {
  createMemoryStore,
  memoryOperations,
  type MemoryOperationContext,
  type MemoryScopeApi,
  type MemoryStoreApi,
} from '@velaros-ai/velar/memory'
import { shellCommandPolicy } from '@velaros-ai/velar/shell'

// 项目空间是一张操作表：宿主每次调用给一份上下文，接成代码面的能力端口；共用能力单元按 `@velaros-ai/velar/<单元>` 引。
declare const projectCall: ProjectCallContext
const projectCapabilities = createCapabilityPort(createProjectSpace({ resolveCall: () => projectCall }).operations)
void [projectCapabilities.listOperations(), shellCommandPolicy.analyze('ls -la').isReadOnly, FileLimits.fileBytes]

declare const source: LanguageReadPort
const languageContext: LanguageToolContext = {
  abortSignal: new AbortController().signal,
  project: {
    getRootPath: () => '/workspace/example',
    kernel: async () => source,
  },
}
void languageQueries.run({ action: 'find_symbols' }, languageContext)

// 办公文档在 velar 的 office 单元里：宿主把环境探测接到空间端口上，操作交回声明好的回执。
declare const inspectFromHost: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
declare const officeContext: OfficeOperationContext
const inspectForOffice: OfficeOperationContext['office']['inspectEnvironment'] = inspectFromHost
const wordWritten: Promise<OfficeWritten> = officeOperations.createWord({ outputPath: 'report.docx', content: '# 周报' }, officeContext)
void [inspectForOffice, wordWritten]

// 记忆在 velar 的 memory 单元里：宿主给根目录造一个记忆库，按会话的作用域取一份、开场排一段索引；三个操作经调用上下文里的作用域端口读写。
const memoryStore: MemoryStoreApi = createMemoryStore({ root: '/srv/velaros/memory' })
const memoryScope: MemoryScopeApi = memoryStore.scope('project:/srv/project')
const memoryContext: MemoryOperationContext = { abortSignal: new AbortController().signal, memory: memoryScope }
void [memoryScope.renderIndex(), memoryStore.listScopes(), memoryOperations.list(memoryContext)]

const retry: AgentModelRetryPolicy = {
 allowPartialContinuation: false,
 onFailure: () => null,
}
const lifecycle: AgentRunLifecycle<object> = {
 beforeTurn: async ({ abortSignal }: { abortSignal: AbortSignal }) => { abortSignal.throwIfAborted() },
 onTurnSettled: async ({ history }: { history: readonly unknown[] }) => (history.length ? 'stop' : 'continue'),
}
const point: ComputerPoint = { x: 10, y: 20, coordinateSpace: 'global' }
void [createAgentExecutionStack, createModelRequestClient, lifecycle, retry,
 agentToolContracts.discoveryDescriptors, agentToolContracts.readSchemaDiscoveryNames({names:['project:read']}), point, ComputerInputLimits.clickCount]
