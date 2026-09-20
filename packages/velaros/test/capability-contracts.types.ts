import { createCapabilityModule } from '../src/index.js'
import { fileOperations, VelarFilesModule, type FileOperationContext } from '../files/index.js'

/** 原领域接口决定宿主上下文，装配无需手写泛型参数。 */
export function bindFiles(context:FileOperationContext) {
  return createCapabilityModule({surface:VelarFilesModule,implementation:fileOperations,instanceId:'typed',context:()=>context})
}
/** 编译器必须在错误端口进入真实调用之前报错。 */
export function rejectWrongContext() {
  return createCapabilityModule({surface:VelarFilesModule,implementation:fileOperations,instanceId:'typed',
    // @ts-expect-error FileOperationContext 要求 files 与 abortSignal。
    context:()=>({sessionId:'wrong domain'}),
  })
}
