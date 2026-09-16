// 域：Agent 领域 Loader（两级注册机的第二级）。
//
// 生命周期 discover → validate → resolve → activate → deactivate（蓝图 §3.4）。
// discover 的 IO 归宿主（见 AgentModHostAssembly）；本文件从「已发现的候选包」开始，
// 全过程同步、纯函数式判定，任何拒载都带可读诊断。
//
// partial activation（蓝图 §3.4 v5）：
//  - 宿主声明它支持哪些贡献轴（`supportedAxes`）；
//  - mod 的某轴在本宿主无落点 → 该轴缺席、mod 仍以 `partial` 态激活，缺席轴进诊断；
//  - `requiredAxes` 命中不支持的轴 → 直接拒载，不做残废激活。
import {
  isArray,
  isBlank,
  isEmpty,
  isPlainObject,
  isString,
  isUndefined,
  toNullable,
} from '@velaros-ai/core'

import type { AgentModContributionAxisName, AgentModDiagnostic, AgentModManifest, AgentModTrustLevel } from '../../types/agent.js'
import type { AgentModActivationState, AgentModAxisRecord, AgentModBindings, AgentModHostProfile, AgentModLoadReport, AgentModPackage, AgentModRegistrySnapshot, AgentModRejection, AgentModSeamHandler, ValidatedAgentMod } from '../../types/mods.js'
import { AgentModContributionAxisNames, listAgentModDeclaredAxes, parseAgentModManifest, readAgentModContributionKey, satisfiesSemverRange } from '../../utils/wire/mods'

import { AgentModRegistry } from './AgentModRegistry'
import { AgentModHookDispatcher } from './AgentModSeamDispatcher'

const DefaultAllowedTrustLevels: readonly AgentModTrustLevel[] = ['bundled-official']

/** 必须有运行态载荷的轴：缺绑定=拒载（绝不静默降级成空贡献）。 */
const PayloadRequiredAxes: ReadonlySet<AgentModContributionAxisName> = new Set(['tools', 'hooks'])

/** 纯数据轴：不接受运行态载荷（代码钩子白名单之外）。 */
const DataOnlyAxes: ReadonlySet<AgentModContributionAxisName> = new Set([
  'spaces',
  'turnContextSources',
])

function readBindingRecord(
  bindings: AgentModBindings,
  axis: AgentModContributionAxisName
): Readonly<Record<string, unknown>> {
  const record = Reflect.get(bindings, axis)
  return isPlainObject(record) ? record : {}
}

function readAxisEntries(
  manifest: AgentModManifest,
  axis: AgentModContributionAxisName
): readonly unknown[] {
  const entries = Reflect.get(manifest.contributes, axis)
  return isArray(entries) ? entries : []
}

/**
 * Agent 领域 mod 装载器。
 *
 * 一次 `load()` = 一个完整 registration 阶段：打开注册面 → 逐包 validate → 跨包 resolve →
 * 逐 mod activate → 封存并推进 generation。任一 mod 在 resolve 阶段冲突即整包拒载
 * （不部分注册），保证注册表永远不落半个 mod。
 */

/**
 * Agent 领域 mod 装载器对外的面：从「宿主已经发现的候选包」开始，把它们判定、去冲突、
 * 落进贡献注册表与 Hook 派发器，并交出一份可读的装载报告。
 *
 * 一个宿主一份，装配期建、长期持有；状态（已激活 mod、拒载记录、诊断）全在实例内存里，不落盘。
 * 判定全程同步且不抛错：任何拒绝都变成带 code 与人话 message 的诊断进报告，宿主照单展示。
 * `requiredAxes` 命中本宿主不支持的轴一律拒载，不做残废激活；某轴只是没落点则该轴缺席、
 * 其余轴照常激活（partial）。实现是 `AgentModLoader`。
 */
export interface AgentModLoaderApi {
  /** 这台 Loader 写入的贡献注册表；消费者从它取按回合冻结的快照。装配期传入或由 Loader 自建。 */
  readonly registry: AgentModRegistry
  /** 这台 Loader 写入的 Hook 派发器；主链在各派发点向它要钩子。装配期传入或由 Loader 自建。 */
  readonly hooks: AgentModHookDispatcher
  /** @deprecated 与 `hooks` 是同一个对象，留给旧调用方；新代码一律用 `hooks`。 */
  readonly seams: AgentModHookDispatcher
  /**
   * 装一批候选包，返回本次之后的完整装载报告。
   * 整个过程是一个 registration 阶段：开注册面 → 逐包判定 → 跨包查主键冲突 → 逐个激活 →
   * 封存并推进 generation（此前发出去的快照全部失效）。
   * 可以重复调，会在既有注册表之上继续追加；mod id 或轴主键撞上已装的，照样整包拒载。
   */
  load(packages: readonly AgentModPackage[]): AgentModLoadReport
  /**
   * 停用一个 mod：摘掉它在注册表与 Hook 派发器上的全部贡献，并记一条 `mod.deactivated` 诊断。
   * 它产出的持久化数据按孤儿保全语义一律保留，绝不静默硬删。没装过这个 mod 时返回 false。
   */
  deactivate(modId: string): boolean
  /**
   * 取一份冻结的装载报告：当前 generation、已激活 mod（含 partial 与各轴贡献数）、
   * 拒载记录，以及 Loader 自己的诊断并上 Hook 派发器的诊断。宿主的 mod 页直接渲染它。
   */
  getReport(): AgentModLoadReport
  /** 取注册表当前 generation 的冻结快照，等价于 `registry.snapshot()`，给只拿到 Loader 的调用方用。 */
  snapshot(): AgentModRegistrySnapshot
}

class AgentModLoader implements AgentModLoaderApi {
  public readonly registry: AgentModRegistry
  public readonly hooks: AgentModHookDispatcher
  /** @deprecated 新调用方使用 `hooks`。 */
  public readonly seams: AgentModHookDispatcher

  private readonly host: AgentModHostProfile
  private readonly supportedAxes: ReadonlySet<AgentModContributionAxisName>
  private readonly allowedTrustLevels: ReadonlySet<AgentModTrustLevel>
  private readonly activated = new Map<string, AgentModActivationState>()
  private readonly rejected: AgentModRejection[] = []
  private readonly diagnostics: AgentModDiagnostic[] = []

  constructor(options: {
    host: AgentModHostProfile
    registry?: AgentModRegistry
    hooks?: AgentModHookDispatcher
    /** @deprecated 新调用方使用 `hooks`。 */
    seams?: AgentModHookDispatcher
    onDiagnostic?: (diagnostic: AgentModDiagnostic) => void
  }) {
    this.host = options.host
    this.registry = options.registry ?? new AgentModRegistry()
    this.hooks = options.hooks ?? options.seams ?? new AgentModHookDispatcher({
      onDiagnostic: options.onDiagnostic,
    })
    this.seams = this.hooks
    this.supportedAxes = new Set(options.host.supportedAxes)
    this.allowedTrustLevels = new Set(options.host.allowedTrustLevels ?? DefaultAllowedTrustLevels)
  }

  /** 装载一批候选包；重复调用会在既有注册表之上继续追加（id/主键冲突照样拒载）。 */
  public load(packages: readonly AgentModPackage[]): AgentModLoadReport {
    this.registry.beginRegistration()
    this.hooks.beginRegistration()
    try {
      const validated: ValidatedAgentMod[] = []
      for (const candidate of packages) {
        const outcome = this.validate(candidate)
        if (outcome.ok) validated.push(outcome.mod)
        else this.reject(outcome.rejection)
      }
      const resolved = this.resolve(validated)
      for (const mod of resolved) this.activate(mod)
    } finally {
      const generation = this.registry.endRegistration()
      this.hooks.seal()
      void generation
    }
    return this.getReport()
  }

  /** 停用一个 mod：摘除其全部贡献与钩子；用户数据一律保留（蓝图 §3.7，绝不静默硬删）。 */
  public deactivate(modId: string): boolean {
    if (!this.activated.has(modId)) return false
    this.registry.beginRegistration()
    this.hooks.beginRegistration()
    try {
      this.registry.removeMod(modId)
      this.hooks.removeMod(modId)
      this.activated.delete(modId)
      this.diagnostics.push({
        code: 'mod.deactivated',
        message: `mod「${modId}」已停用：贡献已摘除，其产出的持久化数据按孤儿保全语义保留，不做删除。`,
        modId,
      })
    } finally {
      this.registry.endRegistration()
      this.hooks.seal()
    }
    return true
  }

  public getReport(): AgentModLoadReport {
    return Object.freeze({
      generation: this.registry.generation,
      activated: Object.freeze([...this.activated.values()]),
      rejected: Object.freeze([...this.rejected]),
      diagnostics: Object.freeze([...this.diagnostics, ...this.hooks.listDiagnostics()]),
    })
  }

  public snapshot(): AgentModRegistrySnapshot {
    return this.registry.snapshot()
  }

  private reject(rejection: AgentModRejection): void {
    this.rejected.push(rejection)
    this.diagnostics.push(...rejection.diagnostics)
  }

  // ─── validate ──────────────────────────────────────────────────────────────

  private validate(
    candidate: AgentModPackage
  ): { ok: true; mod: ValidatedAgentMod } | { ok: false; rejection: AgentModRejection } {
    const parsed = parseAgentModManifest(candidate.manifest, {
      origin: candidate.origin,
    })
    if (!parsed.ok)
      return {
        ok: false,
        rejection: {
          modId: toNullable(parsed.diagnostics[0]?.modId),
          origin: candidate.origin,
          diagnostics: parsed.diagnostics,
        },
      }

    const manifest = parsed.manifest
    const bindings = candidate.bindings ?? {}
    const diagnostics: AgentModDiagnostic[] = []
    const fail = (code: string, message: string, path?: string): void => {
      diagnostics.push({
        code,
        message,
        path,
        modId: manifest.id,
        origin: candidate.origin,
      })
    }

    if (!this.allowedTrustLevels.has(manifest.trust)) {
      fail(
        'mod.trust-not-allowed',
        `信任级 ${manifest.trust} 不在宿主「${this.host.hostId}」允许的集合内（${[...this.allowedTrustLevels].join(', ')}）。`,
        'trust'
      )
    }

    if (!satisfiesSemverRange(this.host.velarosVersion, manifest.engines.velaros)) {
      fail(
        'mod.engine-incompatible',
        `engines.velaros=${manifest.engines.velaros} 与宿主版本 ${this.host.velarosVersion} 不兼容。`,
        'engines.velaros'
      )
    }

    if (
      manifest.engines.agent &&
      !satisfiesSemverRange(this.host.agentApiVersion, manifest.engines.agent)
    ) {
      fail(
        'mod.engine-incompatible',
        `engines.agent=${manifest.engines.agent} 与宿主 Agent capability API ${this.host.agentApiVersion} 不兼容。`,
        'engines.agent'
      )
    }

    const shellRange = this.host.shellId ? manifest.engines.shell?.[this.host.shellId] : undefined
    if (shellRange && this.host.shellVersion) {
      if (!satisfiesSemverRange(this.host.shellVersion, shellRange)) {
        fail(
          'mod.engine-incompatible',
          `engines.shell.${this.host.shellId}=${shellRange} 与宿主壳版本 ${this.host.shellVersion} 不兼容。`,
          'engines.shell'
        )
      }
    } else if (shellRange && !this.host.shellVersion) {
      fail(
        'mod.engine-incompatible',
        `manifest 声明了对壳「${this.host.shellId}」的兼容区间，但宿主未自报壳版本，无法判定。`,
        'engines.shell'
      )
    }

    const declaredAxes = listAgentModDeclaredAxes(manifest)
    const activeAxes = declaredAxes.filter((axis) => this.supportedAxes.has(axis))
    const absentAxes = declaredAxes.filter((axis) => !this.supportedAxes.has(axis))

    for (const axis of manifest.requiredAxes ?? []) {
      if (this.supportedAxes.has(axis)) continue
      fail(
        'mod.required-axis-unsupported',
        `本 mod 需要 ${axis} 轴，宿主「${this.host.hostId}」不提供该轴的落点，拒载（不做残废激活）。`,
        'requiredAxes'
      )
    }

    for (const axis of activeAxes) {
      const bindingRecord = readBindingRecord(bindings, axis)
      const isDataOnly = DataOnlyAxes.has(axis)
      if (isDataOnly && !isEmpty(Object.keys(bindingRecord))) {
        fail(
          'mod.binding-not-allowed',
          `${axis} 是纯数据轴，不接受运行态绑定（代码钩子只允许出现在工具 handler 与 seam 钩子上）。`,
          `contributes.${axis}`
        )
        continue
      }
      for (const entry of readAxisEntries(manifest, axis)) {
        const key = readAgentModContributionKey(axis, entry)
        const payload = Reflect.get(bindingRecord, key)
        if (!isUndefined(payload)) continue
        if (PayloadRequiredAxes.has(axis)) {
          fail(
            'mod.binding-missing',
            `${axis} 条目「${key}」缺运行态绑定；该轴必须提供实现，拒载而不静默降级成空贡献。`,
            `contributes.${axis}`
          )
          continue
        }
        if (axis === 'promptSegments') {
          const text = Reflect.get(entry as object, 'text')
          if (isString(text) && !isBlank(text)) continue
          fail(
            'mod.binding-missing',
            `promptSegments 条目「${key}」既没有 text 也没有运行态绑定，无正文可注入。`,
            'contributes.promptSegments'
          )
        }
      }
    }

    if (!isEmpty(diagnostics))
      return {
        ok: false,
        rejection: {
          modId: manifest.id,
          origin: candidate.origin,
          diagnostics,
        },
      }

    return {
      ok: true,
      mod: {
        manifest,
        bindings,
        source: candidate.source,
        origin: candidate.origin,
        declaredAxes,
        activeAxes,
        absentAxes,
      },
    }
  }

  // ─── resolve ───────────────────────────────────────────────────────────────

  /** 平铺解析：mod id 重复 / 轴主键冲突（含工具名唯一性）一律拒载并给可读诊断。 */
  private resolve(candidates: readonly ValidatedAgentMod[]): ValidatedAgentMod[] {
    const accepted: ValidatedAgentMod[] = []
    const claimed = new Map<AgentModContributionAxisName, Map<string, string>>()
    for (const axis of AgentModContributionAxisNames) claimed.set(axis, new Map())

    for (const candidate of candidates) {
      const modId = candidate.manifest.id
      const diagnostics: AgentModDiagnostic[] = []

      if (this.activated.has(modId) || accepted.some((mod) => mod.manifest.id === modId)) {
        diagnostics.push({
          code: 'mod.duplicate-id',
          message: `mod id「${modId}」已被装载；平铺加载不接受同 id 覆盖（不做加载顺序覆盖）。`,
          modId,
          origin: candidate.origin,
        })
      }

      for (const axis of candidate.activeAxes) {
        const axisClaims = claimed.get(axis)
        if (!axisClaims) continue
        for (const entry of readAxisEntries(candidate.manifest, axis)) {
          const key = readAgentModContributionKey(axis, entry)
          const owner = axisClaims.get(key) ?? this.registry.findOwner(axis, key)
          if (!owner) continue
          diagnostics.push({
            code: axis === 'tools' ? 'mod.tool-name-conflict' : 'mod.contribution-conflict',
            message: `${axis} 主键「${key}」与 mod「${owner}」冲突；${axis === 'tools' ? '工具名全宿主唯一' : '轴内主键全宿主唯一'}，拒载。`,
            path: `contributes.${axis}`,
            modId,
            origin: candidate.origin,
          })
        }
      }

      if (!isEmpty(diagnostics)) {
        this.reject({ modId, origin: candidate.origin, diagnostics })
        continue
      }

      for (const axis of candidate.activeAxes) {
        const axisClaims = claimed.get(axis)
        if (!axisClaims) continue
        for (const entry of readAxisEntries(candidate.manifest, axis)) {
          axisClaims.set(readAgentModContributionKey(axis, entry), modId)
        }
      }
      accepted.push(candidate)
    }

    return accepted
  }

  // ─── activate ──────────────────────────────────────────────────────────────

  private activate(mod: ValidatedAgentMod): void {
    const modId = mod.manifest.id
    let contributionCount = 0

    const contributionsByAxis: Partial<Record<AgentModContributionAxisName, number>> = {}
    for (const axis of mod.activeAxes) {
      const bindingRecord = readBindingRecord(mod.bindings, axis)
      for (const entry of readAxisEntries(mod.manifest, axis)) {
        const key = readAgentModContributionKey(axis, entry)
        const payload = toNullable(Reflect.get(bindingRecord, key))
        this.registry.register(axis, {
          axis,
          modId,
          key,
          declaration: entry,
          payload,
        } as AgentModAxisRecord<typeof axis>)
        contributionCount += 1
        contributionsByAxis[axis] = (contributionsByAxis[axis] ?? 0) + 1
      }
    }

    for (const entry of readAxisEntries(mod.manifest, 'hooks')) {
      if (!mod.activeAxes.includes('hooks')) break
      const declaration = entry as {
        id: string
        event: never
        priority?: number
        matcher?: never
        mode?: 'blocking' | 'background'
        timeoutMs?: number
      }
      const handler = Reflect.get(
        readBindingRecord(mod.bindings, 'hooks'),
        declaration.id
      ) as AgentModSeamHandler
      this.hooks.register({
        modId,
        id: declaration.id,
        event: declaration.event,
        priority: declaration.priority,
        matcher: declaration.matcher,
        mode: declaration.mode,
        timeoutMs: declaration.timeoutMs,
        handler,
      })
    }

    for (const axis of mod.absentAxes) {
      this.diagnostics.push({
        code: 'mod.axis-absent',
        message: `mod「${modId}」的 ${axis} 轴在宿主「${this.host.hostId}」无落点，该轴缺席、其余轴正常激活（partial 激活）。`,
        path: `contributes.${axis}`,
        modId,
        origin: mod.origin,
      })
    }

    this.activated.set(modId, {
      modId,
      version: mod.manifest.version,
      displayName: mod.manifest.displayName ?? '',
      description: mod.manifest.description ?? '',
      publisher: mod.manifest.publisher ?? '',
      trust: mod.manifest.trust,
      permissions: mod.manifest.permissions ?? [],
      source: mod.source,
      origin: mod.origin,
      status: !isEmpty(mod.absentAxes) ? 'partial' : 'active',
      activeAxes: mod.activeAxes,
      absentAxes: mod.absentAxes,
      contributionCount,
      contributionsByAxis,
    })
  }
}

export { AgentModLoader, DataOnlyAxes, PayloadRequiredAxes }
