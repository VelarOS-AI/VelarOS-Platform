import { createActRunService, type ActRunEvent, type ActRunServiceOptions } from '@velaros-ai/agent'
import type { ApprovalPort } from '@velaros-ai/kernel'
import { createRuntime, type VelarosRuntimeOptions } from '@velaros-ai/velaros'
import { createModelRequestClient } from '@velaros-ai/model'
import { languageQueries, type LanguageReadPort, type LanguageToolContext } from '@velaros-ai/velaros/project'
import { ComputerInputLimits, type ComputerPoint } from '@velaros-ai/velaros/computer/contracts'
import { createCapabilityPort } from '@velaros-ai/script'
import { FileLimits } from '@velaros-ai/velaros/files/contracts'
import { createLocalFilePort } from '@velaros-ai/velaros/files/local'
import { officeOperations, type OfficeOperationContext } from '@velaros-ai/velaros/office'
import type { OfficeEnvironmentInspection, OfficeWritten } from '@velaros-ai/velaros/office/contracts'
import {
  createMemoryStore,
  memoryOperations,
  type MemoryOperationContext,
  type MemoryScopeApi,
  type MemoryStoreApi,
} from '@velaros-ai/velaros/memory'
import { projectCapabilityPorts, type ProjectHostPort } from '@velaros-ai/velaros/project'
import { type LocalShellHostApi, shellCommandPolicy, shellOperations } from '@velaros-ai/velaros/shell'
import { createLocalShellHost } from '@velaros-ai/velaros/shell/local'

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

// 办公文档在 velaros 的 office 单元里：宿主把环境探测接到空间端口上，操作交回声明好的回执。
declare const inspectFromHost: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
declare const officeContext: OfficeOperationContext
const inspectForOffice: OfficeOperationContext['office']['inspectEnvironment'] = inspectFromHost
const wordWritten: Promise<OfficeWritten> = officeOperations.createWord({ outputPath: 'report.docx', content: '# 周报' }, officeContext)
void [inspectForOffice, wordWritten]

// 记忆在 velaros 的 memory 单元里：宿主给根目录造一个记忆库，按会话的作用域取一份、开场排一段索引；三个操作经调用上下文里的作用域端口读写。
const memoryStore: MemoryStoreApi = createMemoryStore({ root: '/srv/velaros/memory' })
const memoryScope: MemoryScopeApi = memoryStore.scope('project:/srv/project')
const memoryContext: MemoryOperationContext = { abortSignal: new AbortController().signal, memory: memoryScope }
void [memoryScope.renderIndex(), memoryStore.listScopes(), memoryOperations.list(memoryContext)]

// 主循环与正式装配均从声明入口消费，业务能力沿 Kernel 调用。
declare const loop:ActRunServiceOptions
declare const runtimeOptions:VelarosRuntimeOptions
const service=createActRunService(loop)
const events:AsyncIterable<ActRunEvent>=service.submit('检查发布后的正式入口')
const runtime=createRuntime(runtimeOptions)
const point:ComputerPoint={x:10,y:20,coordinateSpace:'global'}
void [events,runtime,createModelRequestClient,point,ComputerInputLimits.clickCount]
