import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { NodeRuntimeEnvironment, NodeRuntimeLease } from '@velaros-ai/script'

import type { SkillEnvironmentLease, SkillRegistryApi } from '../contract/provides.js'
import type { SkillSessionOptions } from '../contract/requires.js'
import type { SkillActivation } from '../types/skills.js'
import { freezeSkillData } from '../utils/manifest.js'

/** 安装目录只用于发现；依赖环境在首次加载时取得，并保留到所有执行收束。 */
export interface SkillSessionApi extends SkillEnvironmentLease {
  /** 本轮可按需加载的固定安装代次，不包含说明正文。 */
  readonly catalog: readonly SkillActivation[]
  /** 并发加载串行合并，重复名称复用同一份环境。 */
  activate(name: string, signal: AbortSignal): Promise<SkillActivation>
  /** 每次 Node 执行使用最新已加载依赖，发现目录包含全部可用说明入口。 */
  acquireRuntime(signal: AbortSignal): Promise<NodeRuntimeLease>
}

class SkillSession implements SkillSessionApi {
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  private releasing?: Promise<void>
  private readonly leases: SkillEnvironmentLease[]

  public constructor(
    private readonly registry: SkillRegistryApi,
    public readonly catalog: readonly SkillActivation[],
    private current: SkillEnvironmentLease
  ) {
    this.leases = [current]
  }

  public get environment(): NodeRuntimeEnvironment {
    return this.current.environment
  }

  public get skills(): readonly SkillActivation[] {
    return this.current.skills
  }

  public activate(name: string, signal: AbortSignal): Promise<SkillActivation> {
    const activation = this.pending.then(async () => {
      signal.throwIfAborted()
      if (this.closed) throw new AppError('CLOSED', 'Skill 会话已关闭')
      const record = this.catalog.find((skill) => skill.manifest.name === name)
      if (!record) throw new AppError('NOT_FOUND', `Skill 未在本轮安装目录中：${name}`)
      const installed = (await this.registry.list()).find((skill) => skill.manifest.name === name)
      if (installed?.generation !== record.generation)
        throw new AppError('CONFLICT', `Skill 安装状态已变化，请在下一轮重新加载：${name}`)
      const existing = this.skills.find((skill) => skill.manifest.name === name)
      if (existing) return existing
      const next = await this.registry.acquire(
        [...this.skills, record].map((skill) => ({
          name: skill.manifest.name,
          generation: skill.generation,
          grants: skill.grants,
        }))
      )
      if (signal.aborted || this.closed) {
        await next.release()
        signal.throwIfAborted()
        throw new AppError('CLOSED', 'Skill 会话已关闭')
      }
      this.leases.push(next)
      this.current = next
      return next.skills.find((skill) => skill.manifest.name === name)!
    })
    // 失败交给当前调用方；下一次加载仍能继续，不让一次冲突毒化队列。
    this.pending = activation.then(
      () => {},
      () => {}
    )
    return activation
  }

  public async acquireRuntime(signal: AbortSignal): Promise<NodeRuntimeLease> {
    signal.throwIfAborted()
    if (this.closed) throw new AppError('CLOSED', 'Skill 会话已关闭')
    return {
      environment: {
        ...this.environment,
        skills: this.catalog.map((skill) => ({
          name: skill.manifest.name,
          version: skill.manifest.version,
          description: skill.manifest.description,
          directory: skill.directory,
          instructions: skill.manifest.contribution.instructions,
          packages: skill.manifest.contribution.packages,
          capabilities: skill.grants,
        })),
      },
      // 会话及后台执行共同持有全部环境，单个 Node 程序结束不能提前释放。
      release: async () => {},
    }
  }

  public release(): Promise<void> {
    this.closed = true
    this.releasing ??= this.pending
      .then(async () => {
        while (!isEmpty(this.leases)) {
          await this.leases[0]!.release()
          this.leases.shift()
        }
      })
      .finally(() => {
        this.releasing = undefined
      })
    return this.releasing
  }
}

/** 为一次会话建立可发现目录；仅显式选择与工作区默认项预先装配依赖。 */
export async function createSkillSession(options: SkillSessionOptions): Promise<SkillSessionApi> {
  const records = await options.registry.list()
  const selected = options.selection ?? []
  const catalog = records.map((record) => ({
    ...record,
    grants: selected.find((item) => item.name === record.manifest.name)?.grants ?? [
      ...(record.manifest.contribution.hostCapabilities ?? []),
      ...record.manifest.contribution.capabilities.map((item) => item.module),
    ],
  }))
  const initial = await options.registry.acquire(selected)
  return new SkillSession(options.registry, freezeSkillData(catalog), initial)
}
