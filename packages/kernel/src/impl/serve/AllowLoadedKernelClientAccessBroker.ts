import type { KernelClientAccessBroker } from '../../contract/requires'
import type {
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from '../../types/serve'
import type { KernelModuleHost } from '../runtime/KernelModuleHost'
/**
 * 「已装载即可绑」的客户端准入策略；实例由装配守护进程的那一处建。
 *
 * 适用于模块集合本身已经由组合根定死的 Kernel 进程：能装进来的能力就是宿主认可的能力。
 */
export interface AllowLoadedKernelClientAccessBrokerApi extends KernelClientAccessBroker {
  /** 判一次绑定请求：当前装着的模块里有谁提供这件能力就放行，没有就拒绝并说明没人提供它。 */
  requestBind(request: KernelClientCapabilityBindRequest): Promise<KernelClientAccessDecision>
}

/** 放行任何一件由已装载模块提供的能力。 */
export class AllowLoadedKernelClientAccessBroker implements AllowLoadedKernelClientAccessBrokerApi {
  public constructor(private readonly host: KernelModuleHost) {}

  public async requestBind(
    request: KernelClientCapabilityBindRequest
  ): Promise<KernelClientAccessDecision> {
    for (const snapshot of this.host.listModules()) {
      if (snapshot.manifest.provides.some((token) => token.id === request.capabilityId))
        return { status: 'granted' }
    }
    return {
      status: 'denied',
      reason: `能力 "${request.capabilityId}" 没有任何已装载的模块提供`,
    }
  }
}
