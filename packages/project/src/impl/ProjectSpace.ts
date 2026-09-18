/**
 * 项目空间：`ProjectSpace`，接口 `ProjectSpaceApi` 在本文件的类上方，由 `createProjectSpace` 创建。
 *
 * 一个空间就是一张装配表：给哪几件能力、每件能力用哪个端口。能力都在 `@velaros-ai/velar` 里、一件只有一份实现：
 * 项目独有的两件是 `velar:project`（受项目治理的文件：带行号与 fileRef 的读、事务编辑与撤销）与 `velar:code`（问代码之间的关系），
 * 同在 `@velaros-ai/velar/project`；跨空间共用的三件是 `velar:shell`、`velar:sandbox`、`velar:images`。
 * 给共用能力装的项目端口：命令的工作目录钳在项目内、会改项目的命令过修改授权与资源门、输出脱敏（在这个文件里，它要用资源门）；
 * 沙箱只镜像项目内的目录、落回前先核对项目许不许写，看图只看项目里、读取策略许看的（这两个不带状态，在 `utils/ports.ts`）。
 * 这里没有一个字是给模型看的：模型面是五份生成的声明。
 */

import type { CapabilityOperationContext, CapabilityOperationTable, MountedCapabilityModule } from '@velaros-ai/code-surface/contracts'
import { AppError } from '@velaros-ai/core/error'
import type { ImageOperationContext } from '@velaros-ai/velar/images'
import { imageOperations } from '@velaros-ai/velar/images'
import type { ImageViewInput } from '@velaros-ai/velar/images/contracts'
import { VelarImagesModule } from '@velaros-ai/velar/images/contracts'
import type { CodeAnalysisInput, CodeQueryInput, ProjectChangeInput, ProjectEditInput, ProjectExecutionGateApi, ProjectListInput, ProjectReadInput, ProjectSearchInput } from '@velaros-ai/velar/project'
import { projectCodeOperations, projectExecutionGate, projectFileOperations } from '@velaros-ai/velar/project'
import { VelarCodeModule, VelarProjectModule } from '@velaros-ai/velar/project/contracts'
import type { SandboxOperationContext } from '@velaros-ai/velar/sandbox'
import { sandboxOperations } from '@velaros-ai/velar/sandbox'
import { VelarSandboxModule } from '@velaros-ai/velar/sandbox/contracts'
import type { ShellOperationContext, ShellSpacePort } from '@velaros-ai/velar/shell'
import { shellCommandPolicy, shellOperations } from '@velaros-ai/velar/shell'
import { VelarShellModule } from '@velaros-ai/velar/shell/contracts'

import type { ProjectCallContext } from '../contract/requires.js'
import { insideProject, projectImagePort, projectSandboxPort, redactCommandOutput } from '../utils/ports.js'

/** 项目空间：代码面的一张操作表，项目独有的两件能力，加上三件跨空间的能力配上项目的端口。 */
export interface ProjectSpaceApi {
  /**
   * 操作表：`project`、`code`、`shell`、`sandbox`、`images` 五个命名空间，交给 `createCapabilityPort` 接成能力端口。
   * 每次调用都向宿主要一次上下文（项目根、内核、审批通道、取消信号都是**这一次调用**的），端口也按这次的上下文现装。
   */
  readonly operations: CapabilityOperationTable
  /**
   * 挂了哪几件能力、哪几件常驻：项目文件与命令是项目空间的核心，常驻；问代码、演练沙箱、看图只给模块名与方法名，
   * 程序 import 了才把完整声明给模型。代码面的门按它决定给模型看什么、检查程序时加载哪几份声明。
   */
  readonly modules: readonly MountedCapabilityModule[]
}

class ProjectSpace implements ProjectSpaceApi {
  private static readonly Modules: readonly MountedCapabilityModule[] = Object.freeze([
    { surface: VelarProjectModule, resident: true },
    { surface: VelarShellModule, resident: true },
    { surface: VelarCodeModule, resident: false },
    { surface: VelarSandboxModule, resident: false },
    { surface: VelarImagesModule, resident: false },
  ])

  public constructor(
    private readonly resolveCall: (signal: Optional<AbortSignal>) => ProjectCallContext | Promise<ProjectCallContext>,
    private readonly gate: ProjectExecutionGateApi,
  ) {}

  public get modules(): readonly MountedCapabilityModule[] {
    return ProjectSpace.Modules
  }

  public get operations(): CapabilityOperationTable {
    const shell = async (context: CapabilityOperationContext): Promise<ShellOperationContext> => {
      const call = await this.call(context)
      const shellContext: ShellOperationContext = { abortSignal: call.abortSignal, approval: call.approval, shell: this.shellPort(call) }
      if (call.sessionId) shellContext.sessionId = call.sessionId
      return shellContext
    }
    const sandbox = async (context: CapabilityOperationContext): Promise<SandboxOperationContext> => {
      const call = await this.call(context)
      return { abortSignal: call.abortSignal, approval: call.approval, sandbox: projectSandboxPort(call) }
    }
    const images = async (context: CapabilityOperationContext): Promise<ImageOperationContext> => {
      const call = await this.call(context)
      // 图不进返回值：交给代码面的图片通道，程序跑完之后跟在结果后面给模型看。宿主另给了通道就用宿主的。
      return { abortSignal: call.abortSignal, images: projectImagePort(call), attachImage: call.attachImage ?? ((image) => context.attach({ type: 'image-data', ...image })) }
    }
    return {
      project: {
        read: async (input, context) => projectFileOperations.read(input as ProjectReadInput, await this.call(context)),
        list: async (input, context) => projectFileOperations.list(input as ProjectListInput, await this.call(context)),
        search: async (input, context) => projectFileOperations.search(input as ProjectSearchInput, await this.call(context)),
        edit: async (input, context) => projectFileOperations.edit(input as ProjectEditInput, await this.call(context)),
        inspect: async (input, context) => projectFileOperations.inspect(input as ProjectChangeInput, await this.call(context)),
        undo: async (input, context) => projectFileOperations.undo(input as ProjectChangeInput, await this.call(context)),
      },
      code: {
        query: async (input, context) => projectCodeOperations.query(input as CodeQueryInput, await this.call(context)),
        analyze: async (input, context) => projectCodeOperations.analyze(input as CodeAnalysisInput, await this.call(context)),
      },
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
        view: async (input, context) => imageOperations.view(input as ImageViewInput, await images(context)),
      },
    }
  }

  /** 向宿主要这一次调用的上下文。 */
  private call(context: CapabilityOperationContext): Promise<ProjectCallContext> {
    return Promise.resolve(this.resolveCall(context.signal))
  }


  /**
   * `velar:shell` 的项目端口：工作目录钳在项目内，会改项目的命令先过项目的修改授权，
   * 前台命令在项目资源门里排队（只读走读门，其余走写门），输出交给程序之前先脱敏。
   */
  private shellPort(ctx: ProjectCallContext): ShellSpacePort {
    const root = () => ctx.project.getRootPath()
    return {
      resolveCwd: (cwd) => insideProject(root(), cwd ?? '.', '工作目录'),
      commandPolicy: () => ({ scopeLabel: '当前项目', riskScope: 'project-command:dangerous' }),
      reviewCommand: async ({ command, plan, cwd }) => {
        // 只读命令不打扰用户；其余的先过项目的修改授权（宿主可能按会话记住）。
        if (plan.isReadOnly) return
        const decision = await ctx.project.prepareMutation({ cwd, operation: `运行可能修改项目的命令：${command}` })
        if (!decision.approved) throw new AppError('PERMISSION', decision.message)
      },
      runCommand: async (command, options, allowDangerous, abortSignal) => {
        const invoke = () => ctx.project.runCommand(command, options, allowDangerous, abortSignal)
        const signal = abortSignal ?? ctx.abortSignal
        // 后台命令交给宿主的任务管理，不占门；前台命令按只读与否走读门或写门。
        const result = options?.background
          ? await invoke()
          : await this.gate.run(root(), !shellCommandPolicy.isReadOnly(command), signal, invoke)
        return redactCommandOutput(ctx, result)
      },
      listBackgroundTasks: (options) => ctx.project.listBackgroundTasks(options),
      refreshShellEnvironment: () => ctx.project.refreshShellEnvironment(),
      terminateBackgroundTask: (request) => ctx.project.terminateBackgroundTask(request),
    }
  }

}

/**
 * 装一个项目空间。`resolveCall` 每次调用都会被叫一次，给出这一次调用的项目根、内核、审批通道、取消信号与会话。
 */
export function createProjectSpace(input: {
  resolveCall: (signal: Optional<AbortSignal>) => ProjectCallContext | Promise<ProjectCallContext>
}): ProjectSpaceApi {
  return new ProjectSpace(input.resolveCall, projectExecutionGate)
}
