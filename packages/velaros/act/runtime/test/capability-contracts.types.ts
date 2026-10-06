import {
  projectFileOperations,
  type ProjectOperationContext,
  VelarProjectModule,
} from '../../../project/index.js'
import { createCapabilityModule } from '../index.js'

/** 原领域接口决定宿主上下文，装配无需手写泛型参数。 */
export function bindProject(context: ProjectOperationContext) {
  return createCapabilityModule({
    surface: VelarProjectModule,
    implementation: projectFileOperations,
    instanceId: 'typed',
    context: () => context,
  })
}
/** 编译器必须在错误端口进入真实调用之前报错。 */
export function rejectWrongContext() {
  return createCapabilityModule({
    surface: VelarProjectModule,
    implementation: projectFileOperations,
    instanceId: 'typed',
    // @ts-expect-error ProjectOperationContext 要求 project 与 abortSignal。
    context: () => ({ sessionId: 'wrong domain' }),
  })
}
