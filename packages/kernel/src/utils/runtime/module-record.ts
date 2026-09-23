// 域：模块记录上的纯操作。这些都只读写传进来的那条记录，用不到宿主的实例状态。
import { KernelErrorCodes } from '../../contract/constants'
import type { KernelModuleDefinition } from '../../contract/requires'
import type {
  KernelModuleHealth,
  KernelModuleManifest,
  KernelModuleSnapshot,
} from '../../types/kernel.js'
import type { ModuleRecord } from '../../types/runtime'
import { KernelError, toError } from '../errors'

/** 还没问过健康度（刚注册、已挂起、已释放）时的占位值。 */
export const UnknownModuleHealth: KernelModuleHealth = Object.freeze({ status: 'unknown' })

/** 模块就绪但自己没实现 `health()` 时的默认值。 */
export const HealthyModuleHealth: KernelModuleHealth = Object.freeze({ status: 'healthy' })

/** 建一条新的模块记录；`activate` 包一层，免得模块事后换掉自己的入口。 */
export function createModuleRecord(
  definition: KernelModuleDefinition,
  manifest: KernelModuleManifest,
  generation: number
): ModuleRecord {
  return {
    definition: {
      manifest,
      activate: (context) => definition.activate(context),
    },
    generation,
    status: 'registered',
    health: UnknownModuleHealth,
    contextActive: false,
    lifecycleDisposed: false,
  }
}

/** 这条记录的激活上下文还有效吗；失效了就抛 `MODULE_STATE`。 */
export function assertModuleContextActive(record: ModuleRecord): void {
  if (record.contextActive) return
  throw new KernelError(
    KernelErrorCodes.moduleState,
    `内核模块上下文 "${record.definition.manifest.id}" 已经失效`,
    { moduleId: record.definition.manifest.id }
  )
}

/** 把一条记录标成失败：写状态、写健康度、abort 它的信号。 */
export function failModuleRecord(record: ModuleRecord, error: unknown): void {
  const normalized = toError(error)
  record.status = 'failed'
  record.error = normalized.message
  record.health = {
    status: 'unhealthy',
    message: normalized.message,
  }
  record.controller?.abort()
}

/** 跑一次模块的 `dispose` 钩子；只跑一次，重复调用直接返回。 */
export async function disposeModuleLifecycle(record: ModuleRecord): Promise<void> {
  if (record.lifecycleDisposed) return
  record.lifecycleDisposed = true
  await record.lifecycle?.dispose?.()
}

/** 把一条记录投影成只读快照。 */
export function toModuleSnapshot(record: ModuleRecord): KernelModuleSnapshot {
  return Object.freeze({
    manifest: record.definition.manifest,
    status: record.status,
    health: record.health,
    generation: record.generation,
    error: record.error,
  })
}
