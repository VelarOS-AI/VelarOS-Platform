// 域：宿主组装入口（Kernel pack 清单 → Agent 领域 Loader）。
//
// 两级注册机的接缝就在这里：
//  第一级统一 Mod 入口只认 pack descriptor，它把「装了哪些 pack、在哪个目录」告诉宿主；
//  第二级 Agent Loader 只认领域 manifest。宿主（各产品装配层）读取每个启用 pack 的同一份
//  `velaros.mod.json`，有 `agent` 节就路由给本 owner，再用 `module.permissions` 覆盖领域权限投影。
//  `module.provides` 只表示真实 capability，绝不兼任领域路由标记。
//
// 分节单文件（蓝图 v6 §8.3）：一个 mod 一个 `velaros.mod.json`，`module` 节归 Kernel、
// `agent` 节归本主干、`ui` 节归产品壳。本文件只取 agent 节，另外两节读都不读。
//
// 本文件刻意**不 import kernel 协议包**：pack descriptor 以结构化契约（鸭子类型）声明，
// 字段与 `KernelModPackDescriptor` 一一对应（id/kind/version/enabled/provides/specifier）。
// Agent 主干因此在没有 Kernel daemon 的宿主（headless / 测试台）里同样可用。
//
// IO 全部经 `AgentModPackReader` 注入：主干零文件系统依赖，宿主决定怎么读、读不读得动。
import { isUndefined, toOptional } from '@velaros-ai/core'
import { velarosModEnvelopes } from '@velaros-ai/kernel'
import { VelarosModManifestFileName } from '@velaros-ai/kernel/contracts'

import type { AgentModPackReader } from '../../contract/requires.js'
import type { AgentModDiagnostic } from '../../types/agent.js'
import type { AgentModAssembly, AgentModDiscoveryResult, AgentModPackage, AgentModPackDescriptorLike, AgentModRegistrySnapshot, AgentModSurfaceSnapshot, AssembleAgentModsInput } from '../../types/mods.js'
import { createAgentModSurfaceSnapshot } from '../../utils/mods/agent-mod-projection'
import { readErrorMessage } from '../../utils/mods/seams'
import { AgentModLoader } from '../mods/AgentModLoader'

/**
 * 宿主装配层每次装载 mod 时用的无状态组装器：把 Kernel 给的 pack 清单折成 Agent 候选包，
 * 再连同内置包一起交给领域 Loader 注册。所有判定都留诊断，既不静默丢弃也不改写宿主状态。
 */
export interface AgentModHostAssemblerApi {
  /**
   * 把 Kernel 的 pack 清单折算成 Agent 候选包：逐个读 `velaros.mod.json`、只取其中的 agent 节。
   * 跳过一律留痕（禁用 / 未声明 agent 节 / manifest 读不出 / 绑定装不上各有诊断码），返回值里
   * `packages` 是可以进 Loader 的，`diagnostics` 是这一趟的全部跳过与拒载理由。
   */
  discoverAgentModPackages(input: {
    /** Kernel 那边报上来的 pack 清单，含停用的；停用与否由本方法判读并留诊断。 */
    packs: readonly AgentModPackDescriptorLike[]
    /** 宿主注入的读取端口：manifest 与运行态绑定都经它取，主干自己不碰文件系统。 */
    reader: AgentModPackReader
  }): Promise<AgentModDiscoveryResult>
  /**
   * 宿主组装入口：bundled 先、pack 后，一起交给 Loader 注册，返回 Loader 与合并后的装载报告。
   * 顺序只决定「谁先占住主键」——冲突一律拒载并留诊断，不存在后者覆盖前者的加载顺序语义。
   */
  assembleAgentMods(input: AssembleAgentModsInput): Promise<AgentModAssembly>

  /** 把注册表快照投影成宿主面要的 mod 贡献快照。 */
  createSurfaceSnapshot(snapshot: AgentModRegistrySnapshot): AgentModSurfaceSnapshot
}

class AgentModHostAssembler implements AgentModHostAssemblerApi {
  /**
   * 随包官方 mod 的来源：由挂载处（`impl/AgentTools.ts`）注入，组装器自己不认识任何具体工具。
   * `assembleAgentMods` 的入参没给 `bundled` 时才调它。
   */
  constructor(private readonly bundledPackages: () => readonly AgentModPackage[]) {}

  public async discoverAgentModPackages(input: {
    packs: readonly AgentModPackDescriptorLike[]
    reader: AgentModPackReader
  }): Promise<AgentModDiscoveryResult> {
    const packages: AgentModPackage[] = []
    const diagnostics: AgentModDiagnostic[] = []

    for (const descriptor of input.packs) {
      if (!descriptor.enabled) {
        diagnostics.push({
          code: 'mod.pack-disabled',
          message: `pack「${descriptor.id}」已被用户停用，本次不装载；其既有数据按孤儿保全语义保留。`,
          modId: descriptor.id,
          origin: descriptor.specifier,
        })
        continue
      }
      let raw: unknown
      try {
        raw = await input.reader.readManifest({
          packDirectory: descriptor.specifier,
          manifestFileName: VelarosModManifestFileName,
          descriptor,
        })
      } catch (error) {
        // arch-guard:silent-catch-ok 错误被转换为下方 mod.pack-unreadable 结构化诊断。
        // 「文件读不出来」与「文件在但没有 agent 节」是两种病，诊断分开报：前者去查安装/权限，
        // 后者去查 pack 的 provides 与 manifest 内容对不对得上。
        diagnostics.push({
          code: 'mod.pack-unreadable',
          message: `pack「${descriptor.id}」的 ${VelarosModManifestFileName} 读取失败，拒载：${readErrorMessage(error)}`,
          modId: descriptor.id,
          origin: descriptor.specifier,
        })
        continue
      }

      const envelope = velarosModEnvelopes.parse(raw, { origin: descriptor.specifier })
      if (!envelope.ok) {
        for (const diagnostic of envelope.diagnostics) {
          diagnostics.push({ ...diagnostic, modId: diagnostic.modId ?? descriptor.id })
        }
        continue
      }
      if (isUndefined(envelope.envelope.agent)) {
        diagnostics.push({
          code: 'mod.pack-agent-section-absent',
          message: `pack「${descriptor.id}」未声明 agent 节，Agent owner 不处理；其他 section 仍由各自 owner 接收。`,
          modId: descriptor.id,
          origin: descriptor.specifier,
        })
        continue
      }

      try {
        const bindings = await input.reader.loadBindings?.({
          packDirectory: descriptor.specifier,
          manifest: raw,
          descriptor,
        })
        packages.push({
          source: 'pack',
          origin: descriptor.specifier,
          // 权限的单一事实在信封顶层；agent.permissions 只是领域元数据，不得放大权限面。
          manifest: {
            ...envelope.envelope.agent,
            permissions: envelope.envelope.module.permissions,
          },
          bindings: toOptional(bindings),
        })
      } catch (error) {
        // arch-guard:silent-catch-ok 错误被转换为下方 mod.pack-bindings-unloadable 结构化诊断。
        diagnostics.push({
          code: 'mod.pack-bindings-unloadable',
          message: `pack「${descriptor.id}」的运行态绑定装载失败，拒载：${readErrorMessage(error)}`,
          modId: descriptor.id,
          origin: descriptor.specifier,
        })
      }
    }

    return { packages, diagnostics }
  }

  public async assembleAgentMods(input: AssembleAgentModsInput): Promise<AgentModAssembly> {
    const loader =
      input.loader ?? new AgentModLoader({ host: input.host, onDiagnostic: input.onDiagnostic })

    const bundled = input.bundled ?? this.bundledPackages()
    const discovery =
      input.packs && input.reader
        ? await this.discoverAgentModPackages({ packs: input.packs, reader: input.reader })
        : { packages: [], diagnostics: [] as readonly AgentModDiagnostic[] }

    for (const diagnostic of discovery.diagnostics) input.onDiagnostic?.(diagnostic)

    const report = loader.load([...bundled, ...discovery.packages])
    return {
      loader,
      report: Object.freeze({
        ...report,
        diagnostics: Object.freeze([...discovery.diagnostics, ...report.diagnostics]),
      }),
    }
  }

  public createSurfaceSnapshot(snapshot: AgentModRegistrySnapshot): AgentModSurfaceSnapshot {
    return createAgentModSurfaceSnapshot(snapshot)
  }
}

export { AgentModHostAssembler }
