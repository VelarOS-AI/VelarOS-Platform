import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { EnvironmentRegistryApi } from '../../system/contract/provides.js'
import type { RuntimeNodeOptions } from '../contract/requires.js'

/** 将固定 Skill 与每次执行获取的 npm 快照组合，保留原宿主权限。 */
export function withPackageEnvironment(
  node: RuntimeNodeOptions,
  registry: EnvironmentRegistryApi
): RuntimeNodeOptions {
  return {
    cwd: node.cwd,
    directory: node.directory,
    packageDirectory: node.packageDirectory,
    runtime: node.runtime,
    npm: node.npm,
    authorize: node.authorize ? (request, signal) => node.authorize!(request, signal) : undefined,
    execute: (request, output, signal) => node.execute(request, output, signal),
    acquireRuntime: async (signal) => {
      const base = await node.acquireRuntime?.(signal)
      const fixed = base?.environment ?? node.runtime
      try {
        const lease = await registry.acquire(signal)
        const conflicts = lease.environment.packages.filter((pkg) =>
          fixed?.packages.some((item) => item.name === pkg.name)
        )
        if (!isEmpty(conflicts)) {
          await lease.release()
          throw new AppError(
            'CONFLICT',
            `npm 环境与固定 Skill 导入名冲突：${conflicts.map((pkg) => pkg.name).join(', ')}；请使用 npm alias`
          )
        }
        return {
          environment: {
            id: `${fixed?.id ?? 'base'}:${lease.environment.id}`,
            packages: [...(fixed?.packages ?? []), ...lease.environment.packages],
            skills: fixed?.skills ?? [],
          },
          binDirectories: [...lease.binDirectories, ...(base?.binDirectories ?? [])],
          retain: async () => {
            try {
              await lease.retain()
            } finally {
              await base?.retain?.()
            }
          },
          release: async () => {
            try {
              await lease.release()
            } finally {
              await base?.release()
            }
          },
        }
      } catch (error) {
        await base?.release()
        throw error
      }
    },
  }
}
