import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { OperationDefinition, OperationModuleDefinition } from '@velaros-ai/kernel'
import { createNodeCodeRunner, scriptContractCompiler } from '@velaros-ai/script'

import { SkillLimits } from '../contract/constants.js'
import type { SkillCapabilityModuleOptions } from '../contract/requires.js'
import { containedSkillPath, readSkillText } from '../utils/package-io.js'

/** 将已授权的 Skill 能力绑定到同一个 Kernel，第三方入口只在受控 Node 中求值。 */
export interface SkillCapabilityModulesApi {
  /** 读取静态声明并生成代理，安装代码不会进入调用宿主进程。 */
  create(options: SkillCapabilityModuleOptions): Promise<readonly OperationModuleDefinition[]>
}

/** 静态合同负责发现和校验，每次调用固定版本并重新核对授权。 */
class SkillCapabilityModules implements SkillCapabilityModulesApi {
  public async create(
    options: SkillCapabilityModuleOptions
  ): Promise<readonly OperationModuleDefinition[]> {
    const modules: OperationModuleDefinition[] = []
    const mountedHosts = new Set<string>()
    const catalog = options.session?.catalog ?? options.lease.skills
    for (const skill of catalog) {
      for (const name of skill.manifest.contribution.hostCapabilities ?? []) {
        if (
          !skill.grants.includes(name) ||
          name.startsWith('project:language:') ||
          mountedHosts.has(name)
        )
          continue
        mountedHosts.add(name)
        const owners = catalog.filter((owner) => owner.grants.includes(name))
        const host = options.hostModules?.[name]
        if (!host || host.binding.moduleId !== name) {
          if (options.session && !options.lease.skills.some((owner) => owner.grants.includes(name)))
            continue
          throw new AppError('UNAVAILABLE', `Skill 需要的宿主能力未绑定：${name}`)
        }
        const authorize = async (signal: AbortSignal): Promise<void> => {
          const grants = await Promise.allSettled(
            owners.map((owner) =>
              options.registry.assertGranted(owner.manifest.name, owner.generation, name)
            )
          )
          if (!grants.some((grant) => grant.status === 'fulfilled'))
            throw new AppError('PERMISSION', `Skill 能力授权已失效：${name}`)
          if (options.session) {
            const available = owners.filter((_, index) => grants[index]!.status === 'fulfilled')
            const owner =
              available.find((candidate) =>
                options.lease.skills.some((active) => active.generation === candidate.generation)
              ) ?? available[0]!
            await options.session.activate(owner.manifest.name, signal)
          }
        }
        const operations: Record<string, OperationDefinition> = Object.create(null)
        for (const [operation, definition] of Object.entries(host.operations)) {
          operations[operation] = {
            ...definition,
            prepare: definition.prepare
              ? async (input, context) => {
                  await authorize(context.signal)
                  return definition.prepare!(input, context)
                }
              : undefined,
            observe: definition.observe
              ? async (input, context) => {
                  try {
                    await authorize(context.signal)
                  } catch (error) {
                    context.recordEffect('none')
                    throw error
                  }
                  return definition.observe!(input, context)
                }
              : undefined,
            reconcile: definition.reconcile
              ? async (invocation, signal) => {
                  await authorize(signal)
                  return definition.reconcile!(invocation, signal)
                }
              : undefined,
            run: async (input, context) => {
              try {
                await authorize(context.signal)
              } catch (error) {
                context.recordEffect('none')
                throw error
              }
              return definition.run(input, context)
            },
          }
        }
        modules.push({ ...host, operations })
      }

      for (const capability of skill.manifest.contribution.capabilities) {
        if (!skill.grants.includes(capability.module)) continue
        const entry = await containedSkillPath(
          skill.directory,
          join(skill.directory, capability.entry)
        )
        const source = await readSkillText(
          await containedSkillPath(skill.directory, join(skill.directory, capability.contract))
        )
        const { optionalInputs, ...surface } = scriptContractCompiler.compile(
          source,
          capability.module
        )
        const runner = createNodeCodeRunner({
          ...options.node,
          runtime: options.lease.environment,
          acquireRuntime: options.session
            ? (signal) => options.session!.acquireRuntime(signal)
            : options.node.acquireRuntime,
          execute: (request, output, signal) => options.node.execute(request, output, signal),
        })
        const operations: Record<string, OperationDefinition> = Object.create(null)
        for (const name of surface.methods) {
          const { hasInput, ...descriptor } = surface.operations[name]!
          operations[name] = {
            ...descriptor,
            run: async (input, context) => {
              context.signal.throwIfAborted()
              try {
                await options.session?.activate(skill.manifest.name, context.signal)
                await options.registry.assertGranted(
                  skill.manifest.name,
                  skill.generation,
                  capability.module
                )
              } catch (error) {
                context.recordEffect('none')
                throw error
              }
              const result = await runner.run(
                {
                  source: `import * as provider from ${JSON.stringify(pathToFileURL(entry).href)};\nimport {input} from 'velaros:program';\nexport default await provider[${JSON.stringify(name)}](${hasInput ? (optionalInputs.includes(name) ? 'input === null ? undefined : input' : 'input') : ''});`,
                  input,
                  modules: {},
                  blobs: {},
                  operations: {},
                  mode: context.invocation.mode,
                  host: {
                    sessionId: context.invocation.sessionId,
                    executionId: context.invocation.executionId,
                    modules: {},
                  },
                  timeoutMs: SkillLimits.providerTimeoutMs,
                },
                async () => ({
                  error: { code: 'PERMISSION', message: '此能力进程没有其他宿主能力授权' },
                }),
                () => {},
                context.signal
              )
              if (!result.ok)
                throw new AppError(
                  'UNAVAILABLE',
                  result.error?.message ?? 'Skill 能力进程未正常完成'
                )
              context.recordEffect(descriptor.effects === 'none' ? 'none' : 'committed')
              return toNullable(result.value)
            },
          }
        }
        modules.push({
          surface,
          operations,
          summary: skill.manifest.description,
          binding: {
            moduleId: capability.module,
            instanceId: skill.generation,
            generation: 1,
            schemaRevision: surface.revision,
          },
        })
      }
    }
    return modules
  }
}

/** 安装生命周期与能力装配共享同一份环境租约。 */
export const skillCapabilityModules: SkillCapabilityModulesApi = new SkillCapabilityModules()
