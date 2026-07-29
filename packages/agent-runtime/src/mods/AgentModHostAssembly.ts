// 域：宿主组装入口（Kernel pack 清单 → Agent 领域 Loader）。
//
// 两级注册机的接缝就在这里：
//  第一级 Kernel Module Host 只认窄 descriptor，它把「装了哪些 pack、在哪个目录」告诉宿主；
//  第二级 Agent Loader 只认领域 manifest。宿主（各产品装配层）在中间做三件事：
//  按 `provides` 筛出含 Agent 轴的 pack → 读 pack 目录里的 `velaros.agent.mod.json`
//  → 连同运行态绑定喂给 Loader。
//
// 本文件刻意**不 import kernel 协议包**：pack descriptor 以结构化契约（鸭子类型）声明，
// 字段与 `KernelModPackDescriptor` 一一对应（id/kind/version/enabled/provides/specifier）。
// Agent 主干因此在没有 Kernel daemon 的宿主（headless / 测试台）里同样可用。
//
// IO 全部经 `AgentModPackReader` 注入：主干零文件系统依赖，宿主决定怎么读、读不读得动。
import type { AgentModDiagnostic } from '@velaros-ai/agent-protocol'
import {
  AgentModPackManifestFileName,
  AgentModPackProvidesId,
} from '@velaros-ai/agent-protocol'

import type {
  AgentModBindings,
  AgentModHostProfile,
  AgentModLoadReport,
  AgentModPackage,
} from './AgentModLoader'
import { AgentModLoader } from './AgentModLoader'
import { createBuiltinAgentModPackage } from './BuiltinAgentMod'

/**
 * Kernel pack 描述符的结构化契约。
 *
 * 与 kernel-client 的 `KernelModPackDescriptor` 同形：`specifier` 指向 pack 包目录，
 * `provides` 列出该 pack 贡献的能力 id。
 */
interface AgentModPackDescriptorLike {
  readonly id: string
  readonly version: string
  readonly enabled: boolean
  readonly provides: readonly string[]
  readonly specifier: string
  readonly kind?: string
}

/** pack 读取端口：宿主实现 IO，主干只负责编排与判定。 */
interface AgentModPackReader {
  /** 读 pack 目录下的 Agent 轴 manifest；不存在或读失败应抛错（拒载而非静默跳过）。 */
  readManifest(input: {
    packDirectory: string
    manifestFileName: string
    descriptor: AgentModPackDescriptorLike
  }): Promise<unknown> | unknown
  /** 装载 pack 的运行态绑定（工具实体 / 钩子 handler 等）；纯数据 mod 可不实现。 */
  loadBindings?(input: {
    packDirectory: string
    manifest: unknown
    descriptor: AgentModPackDescriptorLike
  }): Promise<AgentModBindings | undefined> | AgentModBindings | undefined
}

interface AgentModDiscoveryResult {
  readonly packages: readonly AgentModPackage[]
  readonly diagnostics: readonly AgentModDiagnostic[]
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * discover：把 Kernel 的 pack 清单折算成 Agent 候选包。
 *
 * 跳过一律留痕（禁用 / 不含 Agent 轴 / 读不出 manifest 各有诊断码），绝不静默丢弃。
 */
async function discoverAgentModPackages(input: {
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
    if (!descriptor.provides.includes(AgentModPackProvidesId)) {
      diagnostics.push({
        code: 'mod.pack-not-agent-axis',
        message: `pack「${descriptor.id}」的 provides 不含 ${AgentModPackProvidesId}，不属 Agent 轴，交由其 owner module 装载。`,
        modId: descriptor.id,
        origin: descriptor.specifier,
      })
      continue
    }

    try {
      const manifest = await input.reader.readManifest({
        packDirectory: descriptor.specifier,
        manifestFileName: AgentModPackManifestFileName,
        descriptor,
      })
      const bindings = await input.reader.loadBindings?.({
        packDirectory: descriptor.specifier,
        manifest,
        descriptor,
      })
      packages.push({
        source: 'pack',
        origin: descriptor.specifier,
        manifest,
        ...(bindings ? { bindings } : {}),
      })
    } catch (error) {
      diagnostics.push({
        code: 'mod.pack-unreadable',
        message: `pack「${descriptor.id}」的 ${AgentModPackManifestFileName} 读取失败，拒载：${readErrorMessage(error)}`,
        modId: descriptor.id,
        origin: descriptor.specifier,
      })
    }
  }

  return { packages, diagnostics }
}

interface AssembleAgentModsInput {
  readonly host: AgentModHostProfile
  /** 随包官方 mod；缺省 = 内置轴 mod（恒加载）。传空数组可显式关掉。 */
  readonly bundled?: readonly AgentModPackage[]
  /** Kernel 报上来的 pack 清单；缺省不做 pack 发现。 */
  readonly packs?: readonly AgentModPackDescriptorLike[]
  readonly reader?: AgentModPackReader
  readonly loader?: AgentModLoader
  readonly onDiagnostic?: (diagnostic: AgentModDiagnostic) => void
}

interface AgentModAssembly {
  readonly loader: AgentModLoader
  readonly report: AgentModLoadReport
}

/**
 * 宿主组装入口：bundled 先、pack 后（bundled 有序数组，pack 平铺）。
 *
 * 顺序只决定「谁先占住主键」——冲突一律拒载并留诊断，不存在后者覆盖前者的加载顺序语义。
 */
async function assembleAgentMods(
  input: AssembleAgentModsInput
): Promise<AgentModAssembly> {
  const loader =
    input.loader ??
    new AgentModLoader({ host: input.host, onDiagnostic: input.onDiagnostic })

  const bundled = input.bundled ?? [createBuiltinAgentModPackage()]
  const discovery =
    input.packs && input.reader
      ? await discoverAgentModPackages({ packs: input.packs, reader: input.reader })
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

export { assembleAgentMods, discoverAgentModPackages }
export type {
  AgentModAssembly,
  AgentModDiscoveryResult,
  AgentModPackDescriptorLike,
  AgentModPackReader,
  AssembleAgentModsInput,
}
