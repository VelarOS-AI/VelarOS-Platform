/**
 * 驱动装配面：本包自带的通用轮询驱动在这里造；宿主自带的驱动也在这里登记与查找。
 * 这是本包唯一认识「驱动」的地方，别处只拿到 `LabDriver`。
 */
import type { LabDriver, LabDriverProvider, PollingDriverAdapter } from '../contract/requires.js'
import type { PollingDriverPolicy } from '../types/agent-lab.js'
import { AgentLabTuning } from '../utils/tuning.js'

import { PollingDriver } from './PollingDriver.js'

/**
 * 驱动的装配与登记处。
 *
 * 本包是 host 无关的，只带一个通用的轮询驱动：适配器回答原生状态，预算、审批、收敛判定都在本包这一侧。
 * 认某个宿主协议的驱动（例如 Desktop 的 Velar Hooks：它自己的地址约定、凭据文件与 `VELAR_HOOKS_*` 环境变量）
 * 一律由那个宿主实现，启动时 `register` 进来，套件运行时再按 id `create` 出一份。实例归本包，进程里只有一份。
 */
export interface LabDriversApi {
  /** 用一个轮询适配器造一份驱动；策略只写要改的那几项，其余取包内可调参数表。 */
  createPolling: (adapter: PollingDriverAdapter, policy?: Partial<PollingDriverPolicy>) => LabDriver
  /** 登记一个宿主自带的驱动；同一个 id 只许登记一次。 */
  register: (provider: LabDriverProvider) => void
  /** 按 id 造一份宿主驱动；没登记过就报错，报错里带上已经登记的 id，好排查。 */
  create: (id: string, parameters?: Readonly<Record<string, unknown>>) => Promise<LabDriver>
  /** 列出已登记的宿主驱动 id，排序后返回。 */
  ids: () => readonly string[]
}

class LabDrivers implements LabDriversApi {
  /** 审批策略的缺省档：评测里不能停下来等人，所以缺省是批准。 */
  private static readonly DefaultConfirmation = 'approve' as const

  private readonly providers = new Map<string, LabDriverProvider>()

  public createPolling(
    adapter: PollingDriverAdapter,
    policy: Partial<PollingDriverPolicy> = {}
  ): LabDriver {
    const resolved: PollingDriverPolicy = {
      pollMs: AgentLabTuning.driver.pollMs,
      settlePolls: AgentLabTuning.driver.settlePolls,
      defaultWallClockMs: AgentLabTuning.driver.defaultWallClockMs,
      confirmation: LabDrivers.DefaultConfirmation,
      ...policy,
    }
    return new PollingDriver(adapter, resolved)
  }

  public register(provider: LabDriverProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`这个驱动已经登记过了: ${provider.id}`)
    this.providers.set(provider.id, provider)
  }

  public async create(
    id: string,
    parameters: Readonly<Record<string, unknown>> = {}
  ): Promise<LabDriver> {
    const provider = this.providers.get(id)
    if (!provider)
      throw new Error(`没有登记过这个驱动: ${id}（已登记: ${this.ids().join(', ') || '无'}）`)
    return provider.create(parameters)
  }

  public ids(): readonly string[] {
    return [...this.providers.keys()].sort()
  }
}

/** 进程里共用的那一份驱动装配面。 */
export const labDrivers: LabDriversApi = new LabDrivers()
