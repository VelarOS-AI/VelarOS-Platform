/**
 * 项目给共用能力装的端口：`ProjectCapabilityPorts` 与整个进程唯一的 `projectCapabilityPorts`。接口 `ProjectCapabilityPortsApi` 在本文件的类上方。
 * 命令的工作目录钳在项目内、前台命令在项目资源门里排队；沙箱只镜像项目内的目录；看图只看项目里的。路径的判定与内核拒绝的翻译在 `utils/capability-ports.ts`。
 */

import { AppError } from '@velaros-ai/core/error'
import type { ImageSpacePort } from '@velaros-ai/velar/images'
import type { RehearsalSandboxHostPort, SandboxSurfacePort } from '@velaros-ai/velar/sandbox'
import type { ShellSpacePort } from '@velaros-ai/velar/shell'
import { shellCommandPolicy } from '@velaros-ai/velar/shell'

import type { ProjectHostPort } from '../../contract/requires.js'
import { genericFailure, insideProject, projectRelativePath } from '../../utils/capability-ports.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 项目空间给三件跨空间共用的能力（`velar:shell`、`velar:sandbox`、`velar:images`）装的端口，按这一次调用的宿主端口现装。
 *
 * 能力本身不认识项目：两个空间的差别全落在端口上，模型那边只有一套说明。装空间是产品的事——产品每次分发调用时拿宿主端口
 * 调这里的方法，把得到的端口塞进那件能力的调用上下文。都不问人：危险命令由 `velar:shell` 自己问，沙箱落回不问。
 */
export interface ProjectCapabilityPortsApi {
  /**
   * `velar:shell` 的项目端口：工作目录按解开符号链接后的真实路径钳在项目内，出了项目在问用户之前就拒绝（PERMISSION）；
   * 前台命令在项目资源门里排队（只读的走读门，其余走写门），后台命令直接交宿主；输出原样交回。
   * 确认文案说「当前项目」，风险分类 `project-command:dangerous`。`abortSignal` 是这次调用的，排队时一直核对。
   */
  shell(project: ProjectHostPort, abortSignal: AbortSignal): ShellSpacePort
  /**
   * `velar:sandbox` 的项目端口：源目录钳在项目内（不给就是项目根）；建、看差量、落回、丢弃、镜像里跑命令都交宿主的沙箱，
   * 落回不问人。宿主没给沙箱时，每个操作都明说这台机器上没有演练沙箱（UNAVAILABLE）。
   */
  sandbox(project: ProjectHostPort, abortSignal: AbortSignal): SandboxSurfacePort
  /**
   * `velar:images` 的项目端口：只看项目里的图（经符号链接指到外面的也不行，PERMISSION），经项目内核取真实路径，
   * 交给模型时写相对项目根的路径；裁图缩图用宿主给的，宿主没给就不带这个口子。
   */
  images(project: ProjectHostPort): ImageSpacePort
}

export class ProjectCapabilityPorts implements ProjectCapabilityPortsApi {
  private readonly gate: ProjectExecutionGateApi

  constructor(gate: ProjectExecutionGateApi) {
    this.gate = gate
  }

  public shell(project: ProjectHostPort, abortSignal: AbortSignal): ShellSpacePort {
    const root = () => project.getRootPath()
    return {
      resolveCwd: (cwd) => insideProject(root(), cwd ?? '.', '工作目录'),
      commandPolicy: () => ({ scopeLabel: '当前项目', riskScope: 'project-command:dangerous' }),
      runCommand: async (command, options, allowDangerous, signal) => {
        const invoke = () => project.runCommand(command, options, allowDangerous, signal)
        // 后台命令交给宿主的任务管理，不占门；前台命令按只读与否走读门或写门。
        return options?.background
          ? invoke()
          : this.gate.run(root(), !shellCommandPolicy.isReadOnly(command), signal ?? abortSignal, invoke)
      },
      listBackgroundTasks: (options) => project.listBackgroundTasks(options),
      refreshShellEnvironment: () => project.refreshShellEnvironment(),
      terminateBackgroundTask: (request) => project.terminateBackgroundTask(request),
    }
  }

  public sandbox(project: ProjectHostPort, abortSignal: AbortSignal): SandboxSurfacePort {
    const sandbox = (): RehearsalSandboxHostPort => {
      if (!project.sandbox) throw new AppError('UNAVAILABLE', '这台机器上没有演练沙箱：要改一批文件直接用 velar:project 的 edit，要跑脚本用 velar:shell 的 run')
      return project.sandbox
    }
    const source = (requested: Optional<string>) => insideProject(project.getRootPath(), requested ?? '.', '沙箱的源目录')
    return {
      createSandbox: async (options) => sandbox().createSandbox({ ...options, source: await source(options?.source) }),
      diffSandbox: (options) => sandbox().diffSandbox(options),
      applySandbox: (options) => sandbox().applySandbox(options),
      discardSandbox: (sandboxId) => sandbox().discardSandbox(sandboxId),
      runInSandbox: (options, signal) => sandbox().runInSandbox(options, signal ?? abortSignal),
      resolveSource: (requested) => source(requested),
    }
  }

  public images(project: ProjectHostPort): ImageSpacePort {
    const port: ImageSpacePort = {
      locate: async (requested) => {
        const path = await projectRelativePath(project.getRootPath(), requested)
        const kernel = await project.kernel()
        const stat = await kernel.stat({ path }).catch((error: unknown) => {
          throw genericFailure(error)
        })
        return { target: stat.absolutePath, shown: path }
      },
    }
    if (project.resizeImage) port.resizeImage = project.resizeImage
    return port
  }
}

/** 整个进程唯一的一份：前台命令都排进同一扇项目资源门。 */
export const projectCapabilityPorts: ProjectCapabilityPortsApi = new ProjectCapabilityPorts(projectExecutionGate)
