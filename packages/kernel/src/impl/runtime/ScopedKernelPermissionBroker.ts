import type {
  KernelModulePermissionRequest,
  KernelPermissionDecision,
} from '../../types/kernel.js'
import type { ScopedKernelPermissionBrokerOptions } from '../../types/runtime'

/**
 * 一个模块看到的权限面。
 *
 * 模块只能为自己声明过的权限位求授权，模块身份与代际由宿主在这里补上——模块给不了别的值，
 * 更填不了「代谁调用」（那是 {@link KernelPermissionRequest} 上的宿主专用字段）。
 * 上下文失效（模块被释放或被替换）之后求授权会被 `assertActive` 拦住。
 */
export interface KernelModulePermissionBroker {
  /** 为一个权限位求授权；没在清单里声明过的权限直接拒，判定前后各查一次上下文是否还有效。 */
  request(
    request: KernelModulePermissionRequest,
  ): Promise<KernelPermissionDecision>
}

export class ScopedKernelPermissionBroker implements KernelModulePermissionBroker {
  public constructor(
    private readonly options: ScopedKernelPermissionBrokerOptions,
  ) {}

  public async request(
    request: KernelModulePermissionRequest,
  ): Promise<KernelPermissionDecision> {
    const { assertActive, broker, generation, manifest } = this.options
    assertActive()
    if (!manifest.permissions.includes(request.permission)) return {
        status: 'denied',
        reason: `模块 "${manifest.id}" 没有声明权限 "${request.permission}"`,
      }

    // 逐个字段抄写，不整体展开：`KernelPermissionRequest` 上的 `callerModuleId` 是宿主专用字段
    // （模块永远不能指名自己以外的调用方）。原来的 `{ ...request }` 会把模块在 JS 里多塞的任何键
    // 原样带到宿主 broker，授权账本就按模块自称的调用方记。
    const decision = await broker.request({
      permission: request.permission,
      reason: request.reason,
      scope: request.scope,
      resource: request.resource,
      details: request.details,
      moduleId: manifest.id,
      generation,
    })
    assertActive()
    return decision
  }
}
