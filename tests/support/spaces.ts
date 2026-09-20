/**
 * 测试用的两份空间装配。仓库里已经没有空间的装配表了：装空间是产品的事（给哪几件能力、每件用哪个端口、哪几件常驻），
 * 仓库层的测试要在真的空间里跑，就在这里照产品会写的样子装一份。只给 tests/ 用，不是公共件。
 *
 * - 系统空间：本机文件与命令常驻，看图、演练沙箱按需；端口都用本机实现（`@velaros-ai/velaros/<单元>/local`），路径按 shell 宿主的 `resolvePath` 解析。
 * - 项目空间：项目文件与命令常驻，问代码、演练沙箱、看图按需；共用能力的项目端口取自 `projectCapabilityPorts`。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type { CapabilityOperationContext, CapabilityOperationTable, MountedCapabilityModule } from '../../packages/script/src/index'
import type { FileOperationContext } from '../../packages/velaros/files/index'
import { fileOperations } from '../../packages/velaros/files/index'
import { VelarFilesModule } from '../../packages/velaros/files/contracts'
import { createLocalFilePort } from '../../packages/velaros/files/local'
import type { ImageAttachment, ImageOperationContext, ImageSpacePort } from '../../packages/velaros/images/index'
import { imageOperations } from '../../packages/velaros/images/index'
import { VelarImagesModule } from '../../packages/velaros/images/contracts'
import { createLocalImagePort } from '../../packages/velaros/images/local'
import type { CodeAnalysisInput, CodeQueryInput, ProjectChangeInput, ProjectEditInput, ProjectHostPort, ProjectListInput, ProjectReadInput, ProjectSearchInput } from '../../packages/velaros/project/index'
import { projectCapabilityPorts, projectCodeOperations, projectFileOperations } from '../../packages/velaros/project/index'
import { VelarCodeModule, VelarProjectModule } from '../../packages/velaros/project/contracts'
import type { RehearsalSandboxHostPort, SandboxOperationContext, SandboxSurfacePort } from '../../packages/velaros/sandbox/index'
import { sandboxOperations } from '../../packages/velaros/sandbox/index'
import { VelarSandboxModule } from '../../packages/velaros/sandbox/contracts'
import type { ShellHostPort, ShellOperationContext, ShellSpacePort } from '../../packages/velaros/shell/index'
import { shellOperations } from '../../packages/velaros/shell/index'
import { VelarShellModule } from '../../packages/velaros/shell/contracts'

/** 一个装好的空间：代码面的操作表，与挂了哪几件、哪几件常驻。 */
export interface TestSpace {
  operations: CapabilityOperationTable
  modules: readonly MountedCapabilityModule[]
}

/** 系统空间每次调用的上下文：取消信号、审批端口、会话，可选的交图通道。 */
export interface SystemSpaceCall {
  abortSignal: AbortSignal
  approval: ApprovalPort
  sessionId?: string
  attachImage?: (image: ImageAttachment) => void
}

/** 项目空间每次调用的上下文：多一个宿主端口（项目根、内核、代码查询、命令、可选的沙箱与缩图）。 */
export interface ProjectSpaceCall extends SystemSpaceCall {
  project: ProjectHostPort
}

type Resolve<T> = (signal: Optional<AbortSignal>) => T | Promise<T>

/** 图不进返回值：宿主另给了交图通道就用宿主的，没给就交给代码面的图片通道，程序跑完之后跟在结果后面给模型看。 */
function attachImageOf(call: SystemSpaceCall, context: CapabilityOperationContext): (image: ImageAttachment) => void {
  return call.attachImage ?? ((image) => context.attach({ type: 'image-data', ...image }))
}

/** 共用能力的操作表：三件在两个空间里一样，只有端口不同。 */
function sharedOperations(
  shell: (context: CapabilityOperationContext) => Promise<ShellOperationContext>,
  sandbox: (context: CapabilityOperationContext) => Promise<SandboxOperationContext>,
  images: (context: CapabilityOperationContext) => Promise<ImageOperationContext>,
): CapabilityOperationTable {
  return {
    shell: {
      run: async (input, context) => shellOperations.run(input, await shell(context)),
      listTasks: async (input, context) => shellOperations.listTasks(input, await shell(context)),
      refreshEnvironment: async (_input, context) => shellOperations.refreshEnvironment(await shell(context)),
      stop: async (input, context) => shellOperations.stop(input, await shell(context)),
    },
    sandbox: {
      create: async (input, context) => sandboxOperations.create(input, await sandbox(context)),
      run: async (input, context) => sandboxOperations.run(input, await sandbox(context)),
      diff: async (input, context) => sandboxOperations.diff(input, await sandbox(context)),
      apply: async (input, context) => sandboxOperations.apply(input, await sandbox(context)),
      discard: async (input, context) => sandboxOperations.discard(input, await sandbox(context)),
    },
    images: {
      view: async (input, context) => imageOperations.view(input, await images(context)),
    },
  }
}

/** 给 shell 的上下文带上会话（给了才带：后台任务按它登记与核对归属）。 */
function shellContextOf(call: SystemSpaceCall, shell: ShellSpacePort): ShellOperationContext {
  const context: ShellOperationContext = { abortSignal: call.abortSignal, approval: call.approval, shell }
  if (call.sessionId) context.sessionId = call.sessionId
  return context
}

/**
 * 装一个系统空间：`shell` 是本机 shell 宿主（或者测试替身，要有 `resolvePath`），`sandbox` 是本机演练沙箱（不给就没有沙箱）。
 * 文件与看图的端口用本机实现，路径都经 `shell.resolvePath` 解析；命令在本机任意目录跑，确认文案说在哪个目录。
 */
export function systemSpace(input: {
  shell: ShellHostPort & { resolvePath(path?: string): string }
  sandbox?: RehearsalSandboxHostPort
  resolveCall: Resolve<SystemSpaceCall>
}): TestSpace {
  const host = input.shell
  const resolvePath = (path?: string) => host.resolvePath(path)
  const files = createLocalFilePort({ resolvePath })
  const imagePort = createLocalImagePort({ resolvePath })
  const shellPort: ShellSpacePort = {
    resolveCwd: async (cwd) => resolvePath(cwd),
    commandPolicy: (cwd) => ({ scopeLabel: cwd ?? '系统运行环境', riskScope: 'system-command:dangerous' }),
    runCommand: (command, options, allowDangerous, abortSignal) => host.runCommand(command, options, allowDangerous, abortSignal),
    listBackgroundTasks: (options) => host.listBackgroundTasks(options),
    refreshShellEnvironment: () => host.refreshShellEnvironment(),
    terminateBackgroundTask: (request) => host.terminateBackgroundTask(request),
  }
  const sandboxHost = (): RehearsalSandboxHostPort => {
    if (!input.sandbox) throw new Error('这个测试空间没有接演练沙箱')
    return input.sandbox
  }
  const sandboxPort: SandboxSurfacePort = {
    createSandbox: (options) => sandboxHost().createSandbox(options),
    diffSandbox: (options) => sandboxHost().diffSandbox(options),
    applySandbox: (options) => sandboxHost().applySandbox(options),
    discardSandbox: (sandboxId) => sandboxHost().discardSandbox(sandboxId),
    runInSandbox: (options, abortSignal) => sandboxHost().runInSandbox(options, abortSignal),
    resolveSource: async (source) => resolvePath(source),
  }
  const call = (context: CapabilityOperationContext) => Promise.resolve(input.resolveCall(context.signal))
  const fileContext = async (context: CapabilityOperationContext): Promise<FileOperationContext> => ({ abortSignal: (await call(context)).abortSignal, files })
  return {
    modules: [
      { surface: VelarFilesModule, resident: true },
      { surface: VelarShellModule, resident: true },
      { surface: VelarImagesModule, resident: false },
      { surface: VelarSandboxModule, resident: false },
    ],
    operations: {
      files: {
        read: async (input, context) => fileOperations.read(input, await fileContext(context)),
        edit: async (input, context) => fileOperations.edit(input, await fileContext(context)),
        undo: async (input, context) => fileOperations.undo(input, await fileContext(context)),
      },
      ...sharedOperations(
        async (context) => shellContextOf(await call(context), shellPort),
        async (context) => {
          const current = await call(context)
          return { abortSignal: current.abortSignal, approval: current.approval, sandbox: sandboxPort }
        },
        async (context) => {
          const current = await call(context)
          return { abortSignal: current.abortSignal, images: imagePort, attachImage: attachImageOf(current, context) }
        },
      ),
    },
  }
}

/** 装一个项目空间：每次调用向 `resolveCall` 要这一次的上下文，共用能力的项目端口按这次的宿主端口现装。 */
export function projectSpace(input: { resolveCall: Resolve<ProjectSpaceCall> }): TestSpace {
  const call = (context: CapabilityOperationContext) => Promise.resolve(input.resolveCall(context.signal))
  const toolContext = async (context: CapabilityOperationContext) => {
    const current = await call(context)
    return { abortSignal: current.abortSignal, project: current.project, sessionId: current.sessionId }
  }
  const imagePort = (current: ProjectSpaceCall): ImageSpacePort => projectCapabilityPorts.images(current.project)
  return {
    modules: [
      { surface: VelarProjectModule, resident: true },
      { surface: VelarShellModule, resident: true },
      { surface: VelarCodeModule, resident: false },
      { surface: VelarSandboxModule, resident: false },
      { surface: VelarImagesModule, resident: false },
    ],
    operations: {
      project: {
        read: async (input, context) => projectFileOperations.read(input as ProjectReadInput, await toolContext(context)),
        list: async (input, context) => projectFileOperations.list(input as ProjectListInput, await toolContext(context)),
        search: async (input, context) => projectFileOperations.search(input as ProjectSearchInput, await toolContext(context)),
        edit: async (input, context) => projectFileOperations.edit(input as ProjectEditInput, await toolContext(context)),
        inspect: async (input, context) => projectFileOperations.inspect(input as ProjectChangeInput, await toolContext(context)),
        undo: async (input, context) => projectFileOperations.undo(input as ProjectChangeInput, await toolContext(context)),
      },
      code: {
        query: async (input, context) => projectCodeOperations.query(input as CodeQueryInput, await toolContext(context)),
        analyze: async (input, context) => projectCodeOperations.analyze(input as CodeAnalysisInput, await toolContext(context)),
      },
      ...sharedOperations(
        async (context) => {
          const current = await call(context)
          return shellContextOf(current, projectCapabilityPorts.shell(current.project, current.abortSignal))
        },
        async (context) => {
          const current = await call(context)
          return { abortSignal: current.abortSignal, approval: current.approval, sandbox: projectCapabilityPorts.sandbox(current.project, current.abortSignal) }
        },
        async (context) => {
          const current = await call(context)
          return { abortSignal: current.abortSignal, images: imagePort(current), attachImage: attachImageOf(current, context) }
        },
      ),
    },
  }
}
