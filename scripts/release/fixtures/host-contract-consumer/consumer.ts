import {
  createAgentExecutionStack,
  type AgentModelRetryPolicy,
  type AgentRunLifecycle,
} from '@velaros-ai/agent'
import { agentToolContracts, type ApprovalPort } from '@velaros-ai/agent/tool-contract'
import { createModelRequestClient } from '@velaros-ai/model'
import { languageQueries, type LanguageReadPort, type LanguageToolContext } from '@velaros-ai/development'
import { ComputerInputLimits, type ComputerPoint } from '@velaros-ai/velar/computer/contracts'
import { createCapabilityPort } from '@velaros-ai/code-surface'
import { FileLimits } from '@velaros-ai/velar/files/contracts'
import { createLocalFilePort } from '@velaros-ai/velar/files/local'
import { officeOperations, type OfficeOperationContext } from '@velaros-ai/velar/office'
import type { OfficeEnvironmentInspection, OfficeWritten } from '@velaros-ai/velar/office/contracts'
import {
  createMemoryStore,
  memoryOperations,
  type MemoryOperationContext,
  type MemoryScopeApi,
  type MemoryStoreApi,
} from '@velaros-ai/velar/memory'
import { projectCapabilityPorts, type ProjectHostPort } from '@velaros-ai/velar/project'
import { type LocalShellHostApi, shellCommandPolicy, shellOperations } from '@velaros-ai/velar/shell'
import { createLocalShellHost } from '@velaros-ai/velar/shell/local'

// 空间由宿主自己装：共用能力的项目端口从 projectCapabilityPorts 取，本机实现从各单元的 `./local` 入口取，再接成代码面的能力端口。
declare const projectHost: ProjectHostPort
declare const approval: ApprovalPort
const localShell: LocalShellHostApi = createLocalShellHost({ cwd: '/workspace/example' })
const machineFiles = createLocalFilePort({ resolvePath: (path) => localShell.resolvePath(path) })
const projectCapabilities = createCapabilityPort({
  shell: {
    run: async (input, context) => {
      const abortSignal = context.signal ?? new AbortController().signal
      return shellOperations.run(input, { abortSignal, approval, shell: projectCapabilityPorts.shell(projectHost, abortSignal) })
    },
  },
})
void [projectCapabilities.listOperations(), machineFiles.locate('~/notes.md'), shellCommandPolicy.analyze('ls -la').isReadOnly, FileLimits.fileBytes]

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
