import { isEmpty } from '@velaros-ai/core'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'
import { createCapabilityModule } from '@velaros-ai/velaros'
import { imageOperations, VelarImagesModule } from '@velaros-ai/velaros/images'

import type {
  ProjectCapabilityModuleOptions,
  ProjectImagesModuleOptions,
} from '../../contract/requires.js'
import { VelarCodeModule, VelarProjectModule } from '../../contract/surface.js'

import { projectCapabilityPorts } from './ProjectCapabilityPorts.js'
import { projectCodeOperations } from './ProjectCodeOperations.js'
import { projectFileOperations } from './ProjectFileOperations.js'

/** 项目领域模块的显式装配 API，工厂共享同一个实现而不持有产品资源。 */
export interface ProjectModulesApi {
  /** 将已授权项目文件端口挂到共享 Kernel。 */
  project(options: ProjectCapabilityModuleOptions): OperationModuleDefinition
  /** 将同一项目的代码查询端口挂到共享 Kernel。 */
  code(options: ProjectCapabilityModuleOptions): OperationModuleDefinition
  /** 将项目范围的图片端口挂到共享 Kernel。 */
  images(options: ProjectImagesModuleOptions): OperationModuleDefinition
}

class ProjectModules implements ProjectModulesApi {
  /** 项目上的 velaros:project：读、列、搜与按路径改，都经同一个项目内核。 */
  public project(options: ProjectCapabilityModuleOptions): OperationModuleDefinition {
    return createCapabilityModule({
      surface: VelarProjectModule,
      implementation: projectFileOperations,
      instanceId: options.instanceId,
      generation: options.generation,
      context: (call) => ({
        project: options.project,
        resolveProject: options.resolveProject,
        invocationId: call.invocation.id,
        sessionId: call.invocation.sessionId,
        abortSignal: call.signal,
        recordProjectCommit: (fact) => {
          const bounded = {
            ...fact,
            fileStats: { ...fact.fileStats },
            changedFiles: [...fact.changedFiles],
            omittedFiles: 0,
          }
          while (JSON.stringify(bounded).length > 2048 && !isEmpty(bounded.changedFiles)) {
            const path = bounded.changedFiles.pop()!
            delete bounded.fileStats[path]
            bounded.omittedFiles += 1
          }
          call.recordEffect('committed')
          call.recordDiagnostic?.({
            code: 'PROJECT_TRANSACTION_COMMITTED',
            message: JSON.stringify(bounded),
          })
        },
        recordWriteOutcome: (outcome) =>
          call.recordEffect(outcome === 'applied' ? 'committed' : 'none'),
        recordSnapshotCompletion: () => {
          if (call.invocation.mode === 'observe')
            call.recordObservation?.({ completed: true, protection: 'full' })
        },
        recordSnapshotMetrics: (metrics) =>
          call.recordDiagnostic?.({
            code: 'PROJECT_SNAPSHOT_COST',
            message: JSON.stringify(metrics),
          }),
      }),
    })
  }

  /** 项目上的 velaros:code：语言查询只借项目内核的只读端口；图谱类查询经项目端口的 queryCode。 */
  public code(options: ProjectCapabilityModuleOptions): OperationModuleDefinition {
    return createCapabilityModule({
      surface: VelarCodeModule,
      implementation: projectCodeOperations,
      instanceId: options.instanceId,
      generation: options.generation,
      context: (call) => ({
        project: options.project,
        resolveProject: options.resolveProject,
        sessionId: call.invocation.sessionId,
        abortSignal: call.signal,
      }),
    })
  }

  /** 项目上的 velaros:images：只看项目里的图，图经代码面的图片通道跟在结果后面交给模型。 */
  public images(options: ProjectImagesModuleOptions): OperationModuleDefinition {
    const project = { ...options.project, resizeImage: options.resizeImage }
    const images = projectCapabilityPorts.images(project)
    return createCapabilityModule({
      surface: VelarImagesModule,
      implementation: imageOperations,
      instanceId: options.instanceId,
      generation: options.generation,
      context: (call) => ({
        abortSignal: call.signal,
        images,
        attachImage: (image) => call.attach({ type: 'image-data', ...image }),
      }),
    })
  }
}

/** 显式挂载项目文件模块，复用共享 Kernel。 */
export function createProjectCapabilityModule(
  options: ProjectCapabilityModuleOptions
): OperationModuleDefinition {
  return new ProjectModules().project(options)
}

/** 显式挂载项目代码模块，复用同一项目端口。 */
export function createProjectCodeModule(
  options: ProjectCapabilityModuleOptions
): OperationModuleDefinition {
  return new ProjectModules().code(options)
}

/** 显式挂载项目图片模块，沿用项目资源边界。 */
export function createProjectImagesModule(
  options: ProjectImagesModuleOptions
): OperationModuleDefinition {
  return new ProjectModules().images(options)
}
