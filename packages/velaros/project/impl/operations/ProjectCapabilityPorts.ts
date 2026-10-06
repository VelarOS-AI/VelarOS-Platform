/**
 * 项目给共用能力装的端口：`ProjectCapabilityPorts` 与整个进程唯一的 `projectCapabilityPorts`。接口 `ProjectCapabilityPortsApi` 在本文件的类上方。
 * 沙箱只镜像项目内的目录；看图只看项目里的。路径的判定与内核拒绝的翻译在 `utils/capability-ports.ts`。
 */

import { AppError } from '@velaros-ai/core/error'
import type { ImageSpacePort } from '@velaros-ai/velaros/images'
import type { RehearsalSandboxHostPort, SandboxSurfacePort } from '@velaros-ai/velaros/sandbox'

import type { ProjectHostPort, ProjectImagesHost } from '../../contract/requires.js'
import { genericFailure, insideProject, projectRelativePath } from '../../utils/capability-ports.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 项目空间给沙箱与图片能力（`velaros:sandbox`、`velaros:images`）装的端口，按这一次调用的宿主端口现装。
 *
 * 能力本身不认识项目：两个空间的差别全落在端口上，模型那边只有一套说明。装空间是产品的事——产品每次分发调用时拿宿主端口
 * 调这里的方法，把得到的端口塞进那件能力的调用上下文。权限由对应能力和宿主共同实施。
 */
export interface ProjectCapabilityPortsApi {
  /**
   * `velaros:sandbox` 的项目端口：源目录钳在项目内（不给就是项目根）；每次按句柄操作都重新核对当前项目对真实源目录的授权，落回走项目写门；建、看差量、落回、丢弃、镜像里跑命令都交宿主的沙箱，
   * 落回不问人。宿主没给沙箱时，每个操作都明说这台机器上没有演练沙箱（UNAVAILABLE）。
   */
  sandbox(project: ProjectHostPort, abortSignal: AbortSignal): SandboxSurfacePort
  /**
   * `velaros:images` 的项目端口：只看项目里的图（经符号链接指到外面的也不行，PERMISSION），经项目内核取真实路径，
   * 交给模型时写相对项目根的路径；裁图缩图用宿主给的，宿主没给就不带这个口子。
   */
  images(project: ProjectImagesHost): ImageSpacePort
}

export class ProjectCapabilityPorts implements ProjectCapabilityPortsApi {
  private readonly gate: ProjectExecutionGateApi

  constructor(gate: ProjectExecutionGateApi) {
    this.gate = gate
  }

  public sandbox(project: ProjectHostPort, abortSignal: AbortSignal): SandboxSurfacePort {
    const sandbox = (): RehearsalSandboxHostPort => {
      if (!project.sandbox)
        throw new AppError(
          'UNAVAILABLE',
          '这台机器上没有演练沙箱：要改一批文件直接用 velaros:project 的 edit，要跑命令用 Node.js 的 Execa'
        )
      return project.sandbox
    }
    const source = (requested: Optional<string>) =>
      insideProject(project.getRootPath(), requested ?? '.', '沙箱的源目录')
    const authorize = async (sandboxId: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      const host = sandbox()
      const record = host.getSandboxRecord
        ? await host.getSandboxRecord(sandboxId, signal)
        : await host.diffSandbox({ sandboxId, textDiffs: false }, signal)
      await source(record.source)
      signal.throwIfAborted()
      return host
    }
    return {
      createSandbox: async (options, signal = abortSignal) => {
        const resolved = await source(options?.source)
        signal.throwIfAborted()
        return sandbox().createSandbox({ ...options, source: resolved }, signal)
      },
      diffSandbox: async (options, signal = abortSignal) => {
        const host = await authorize(options.sandboxId, signal)
        return host.diffSandbox(options, signal)
      },
      applySandbox: (options, signal = abortSignal) =>
        this.gate.run(project.getRootPath(), true, signal, async () => {
          const host = await authorize(options.sandboxId, signal)
          return host.applySandbox(options, signal)
        }),
      discardSandbox: async (sandboxId, signal = abortSignal) => {
        let host: RehearsalSandboxHostPort
        try {
          host = await authorize(sandboxId, signal)
        } catch (error) {
          signal.throwIfAborted()
          if (AppError.from(error).code === 'NOT_FOUND') return { sandboxId, removed: false }
          throw error
        }
        return host.discardSandbox(sandboxId, signal)
      },
      runInSandbox: async (options, signal = abortSignal) => {
        const host = await authorize(options.sandboxId, signal)
        return host.runInSandbox(options, signal)
      },
      resolveSource: (requested) => source(requested),
    }
  }

  public images(project: ProjectImagesHost): ImageSpacePort {
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
export const projectCapabilityPorts: ProjectCapabilityPortsApi = new ProjectCapabilityPorts(
  projectExecutionGate
)
