import { isBlank, isUndefined } from '@velaros-ai/core'

import type { KernelCallableCapabilityOperation, KernelCallableCapabilityService } from '../../contract/requires'
import type { KernelModuleDefinition } from '../../contract/requires'
import type { CapabilityRequirement, CapabilityToken } from '../../types/kernel.js'

import { KernelCallableCapability } from './KernelCallableCapability'

/**
 * 写内核模块要用的四件小工具，合成一件产品面能力。
 *
 * 能力包与宿主只从这里取：令牌、依赖声明、模块定义、可调用能力表。做成实例方法而不是四个
 * 顶层泛型函数，是因为门禁按登记的接口求公开面闭包——方法上的类型参数不算对 impl 的引用，
 * 顶层泛型工厂的类型参数会被当成「公开签名引用了 impl」。
 */
export interface KernelModuleKitApi {
  /** 造一枚能力令牌；id 与版本都不能为空，返回的对象是冻结的。 */
  token<TService extends object = object>(
    id: string,
    version?: string,
  ): CapabilityToken<TService>
  /** 把一枚令牌写成清单里的依赖声明；不给版本范围就是接受任意版本。 */
  requirement(token: CapabilityToken, versionRange?: string): CapabilityRequirement
  /** 原样交回模块定义，只在编译期核对它符合 ABI，并保住调用方写下的精确类型。 */
  define<TModule extends KernelModuleDefinition>(module: TModule): TModule
  /** 把一张操作表做成内核认的可调用能力；未知操作在求权限之前就被拒绝。 */
  callable(
    operations: Readonly<Record<string, KernelCallableCapabilityOperation>>,
  ): KernelCallableCapabilityService
}

export class KernelModuleKit implements KernelModuleKitApi {
  /** 不写版本时令牌用的缺省能力版本。 */
  private static readonly defaultCapabilityVersion = '1.0.0'

  public token<TService extends object = object>(
    id: string,
    version: string = KernelModuleKit.defaultCapabilityVersion,
  ): CapabilityToken<TService> {
    if (isBlank(id.trim())) {
      throw new Error('能力令牌的 id 不能为空')
    }
    if (isBlank(version.trim())) {
      throw new Error('能力令牌的 version 不能为空')
    }
    return Object.freeze({ id, version })
  }

  public requirement(
    token: CapabilityToken,
    versionRange?: string,
  ): CapabilityRequirement {
    return isUndefined(versionRange)
      ? Object.freeze({ id: token.id })
      : Object.freeze({ id: token.id, versionRange })
  }

  public define<TModule extends KernelModuleDefinition>(module: TModule): TModule {
    return module
  }

  public callable(
    operations: Readonly<Record<string, KernelCallableCapabilityOperation>>,
  ): KernelCallableCapabilityService {
    return new KernelCallableCapability(operations)
  }
}

/** 整个进程共用的模块 SDK；能力包与宿主都用它，不自己 new。 */
export const kernelModules: KernelModuleKitApi = new KernelModuleKit()

/** 造一枚能力令牌（等价于 `kernelModules.token`，为老调用点保留）。 */
export function createCapabilityToken<TService extends object = object>(
  id: string,
  version?: string,
): CapabilityToken<TService> {
  return kernelModules.token<TService>(id, version)
}

/** 把令牌写成清单依赖（等价于 `kernelModules.requirement`，为老调用点保留）。 */
export function requireCapability(
  token: CapabilityToken,
  versionRange?: string,
): CapabilityRequirement {
  return kernelModules.requirement(token, versionRange)
}

/** 原样交回模块定义并保住精确类型（等价于 `kernelModules.define`，为老调用点保留）。 */
export function defineKernelModule<TModule extends KernelModuleDefinition>(
  module: TModule,
): TModule {
  return kernelModules.define(module)
}
