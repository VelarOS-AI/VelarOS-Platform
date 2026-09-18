/**
 * Agent 运行时的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 *
 * 改动或删除已有用例要在差量报告里点名并说明理由。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  AgentContextThresholds,
  AgentToolCategoryByName,
  AgentToolLimits,
  AgentToolNames,
} from '../src/contract/constants'
import { AgentModLoader } from '../src/impl/mods/AgentModLoader'
import {
  agentChat,
  agentModHost,
  agentSessionKit,
  agentTools,
  createBuiltinAgentModDefinition,
  createExecutionEventBus,
  createNoopExecutionEventBus,
  createTurnContextSessionLedgers,
  toolTransportNames,
} from '../src/index'
import {
  createUnattendedSubAgentApprovalPort,
  defaultDenyApprovalPort,
  defaultUnsupportedInteractionPort,
  toolContracts,
  toolDescriptions,
  toolInputReuseStore,
} from '../src/tool-contract'
import type { AgentModDiagnostic, AgentModManifest } from '../src/types/agent'
import type { AgentModHostProfile } from '../src/types/mods'
import type { DefineToolRuntimeSpecInput } from '../src/types/toolkit'
import { resolveAgentSessionLeaseClaim } from '../src/utils/product-session/lifecycle'
import { createToolCallableOperations } from '../src/utils/toolkit/callable-operations'
import { resolveToolReadOnly } from '../src/utils/toolkit/define-tool-contract'
import {
  isStructuredToolDescription,
  parseStructuredToolDescription,
  renderToolDescription,
} from '../src/utils/toolkit/tool-description'
import { AgentTuning } from '../src/utils/tuning'

function createModHost(): AgentModHostProfile {
  return {
    hostId: 'spec-host',
    velarosVersion: '1.0.0',
    agentApiVersion: '1.0.0',
    supportedAxes: ['tools'],
    allowedTrustLevels: ['bundled-official', 'local-dev'],
  }
}

function manifestOf(id: string, tools: readonly string[]): AgentModManifest {
  return {
    id,
    version: '1.0.0',
    publisher: 'spec',
    displayName: id,
    description: 'spec 用的最小 mod',
    manifestSchemaVersion: 1,
    engines: { velaros: '*', agent: '*' },
    trust: 'local-dev',
    contributes: {
      tools: tools.map((name) => ({ name, category: 'agent-control', summary: name })),
    },
  } as unknown as AgentModManifest
}

describe('INV-1 默认审批端口一律拒绝', () => {
  test('INV-1 没注入审批端口时，要审批的工具拿不到放行', async () => {
    await expect(defaultDenyApprovalPort.awaitConfirmation('要删掉这个目录吗？')).rejects.toThrow()
  })
})

describe('INV-2 无人值守审批只按显式升级钩子放行', () => {
  test('INV-2 钩子缺席时无人值守端口原样转交给被拒的委托端口', async () => {
    const port = createUnattendedSubAgentApprovalPort(defaultDenyApprovalPort)
    await expect(port.awaitConfirmation('子 Agent 要写文件')).rejects.toThrow()
  })

  test('INV-2 显式说不升级时才自动放行，不去打扰父端口', async () => {
    let asked = 0
    const counting = {
      awaitConfirmation: async () => {
        asked += 1
      },
    } as never
    const port = createUnattendedSubAgentApprovalPort(counting, undefined, () => false)
    await port.awaitConfirmation('子 Agent 要写文件')
    expect(asked).toBe(0)
  })
})

describe('INV-3 缺省交互端口只给空态', () => {
  test('INV-3 没注入交互端口时计划与任务面恒空，不伪造会话状态', () => {
    expect(defaultUnsupportedInteractionPort.executionId).toBe('')
    expect(defaultUnsupportedInteractionPort.getCurrentPlan()).toEqual([])
    expect(defaultUnsupportedInteractionPort.updateCurrentPlan({} as never)).toEqual([])
    expect(defaultUnsupportedInteractionPort.getCurrentTask()).toBeNull()
  })
})

describe('INV-4 内置工具名是闭集', () => {
  test('INV-4 每个内置工具都在常量表里，并且有唯一类别', () => {
    const declared = new Set<string>(Object.values(AgentToolNames))
    const categories = AgentToolCategoryByName as Record<string, string>
    for (const name of Object.keys(agentTools)) {
      expect(declared.has(name)).toBe(true)
      expect(typeof categories[name]).toBe('string')
    }
    expect(Object.keys(agentTools).length).toBeGreaterThan(0)
  })
})

describe('INV-5 内置 mod 的工具清单由单源派生', () => {
  test('INV-5 内置 mod 的 bindings.tools 与 agentTools 逐项一致', () => {
    const builtin = createBuiltinAgentModDefinition()
    expect(Object.keys(builtin.bindings.tools ?? {}).sort()).toEqual(Object.keys(agentTools).sort())
    const contributed = (builtin.manifest.contributes.tools ?? []).map((tool) => tool.name).sort()
    expect(contributed).toEqual(Object.keys(agentTools).sort())
  })
})

describe('INV-6 mod 贡献轴是闭集', () => {
  test('INV-6 清单里出现集合外的轴一律拒载并留诊断', () => {
    const diagnostics: AgentModDiagnostic[] = []
    const loader = new AgentModLoader({ host: createModHost(), onDiagnostic: (d) => diagnostics.push(d) })
    const manifest = manifestOf('spec.unknown-axis', [])
    ;(manifest.contributes as Record<string, unknown>).notAnAxis = [{ id: 'x' }]
    const report = loader.load([{ source: 'pack', origin: 'spec', manifest, bindings: {} } as never])
    expect(report.diagnostics.length + diagnostics.length).toBeGreaterThan(0)
  })
})

describe('INV-7 工具名冲突拒载', () => {
  test('INV-7 两个 mod 挂同一个工具名时后者被拒并留诊断', () => {
    const loader = new AgentModLoader({ host: createModHost() })
    const first = { source: 'pack', origin: 'a', manifest: manifestOf('spec.a', ['probe:same']), bindings: { tools: { 'probe:same': { name: 'probe:same' } } } }
    const second = { source: 'pack', origin: 'b', manifest: manifestOf('spec.b', ['probe:same']), bindings: { tools: { 'probe:same': { name: 'probe:same' } } } }
    const report = loader.load([first, second] as never)
    expect(report.diagnostics.length).toBeGreaterThan(0)
  })
})

describe('INV-8 执行事件总线', () => {
  test('INV-8 空总线不往外发；装了处理器的总线逐条送到', () => {
    const seen: unknown[] = []
    expect(() => createNoopExecutionEventBus().emitAgent({ type: 'spec' } as never)).not.toThrow()
    const bus = createExecutionEventBus({ agent: (event) => seen.push(event) })
    bus.emitAgent({ type: 'spec' } as never)
    expect(seen).toHaveLength(1)
  })
})

describe('INV-9 入参复用不跨上下文', () => {
  test('INV-9 只有显式登记过复用信封的 schema 才允许复用', () => {
    const plain = { type: 'object' }
    expect(toolInputReuseStore.supportsReuse(plain)).toBe(false)
    toolInputReuseStore.markReusable(plain)
    expect(toolInputReuseStore.supportsReuse(plain)).toBe(true)
    expect(toolInputReuseStore.supportsReuse({ type: 'object' })).toBe(false)
  })
})

describe('INV-10 模型可见的工具结果有硬上限', () => {
  test('INV-10 超限的结果被截断，但原文仍可按召回形态取回', () => {
    const huge = { text: 'x'.repeat(AgentToolLimits.payload.modelToolResultChars * 2) }
    const forModel = agentChat.serializeToolResultForModel(huge)
    const forRecall = agentChat.serializeToolResultForRecall(huge)
    expect(forModel.length).toBeLessThanOrEqual(AgentToolLimits.payload.modelToolResultChars + 4096)
    expect(forRecall.length).toBeGreaterThan(forModel.length)
  })
})

describe('INV-11 提醒线只提示、治理线才动手', () => {
  test('INV-11 两条线的次序固定：提醒线严格低于治理线', () => {
    expect(AgentContextThresholds.highWatermarkPercent).toBeLessThan(
      AgentContextThresholds.compactionPercent
    )
  })
})

describe('INV-12 回合上下文账本换代不吞 delta', () => {
  test('INV-12 消费方带着别的代次来 peek 时拿到整段替换而不是空结果', () => {
    const ledgers = createTurnContextSessionLedgers('spec.source', { maxEntries: 8 })
    ledgers.append('spec-session', { label: '变化', summaryText: '第一条' })
    // 代次对不上：不回放旧 delta，只交出当前基底，消费方据此整段替换 cursor。
    const stale = ledgers.peek('spec-session', { afterSeq: 0, generation: 'g_other' })
    expect(stale.generation).not.toBe('g_other')
    expect(stale.deltas.length).toBe(0)
    expect(stale.tailSeq).toBe(1)
    // 换回当前代次后，同一条 delta 仍然读得到，没有被吞掉。
    const current = ledgers.peek('spec-session', { afterSeq: 0, generation: stale.generation })
    expect(current.deltas.length).toBe(1)
  })
})

describe('INV-13 工具传输名双向可还原', () => {
  test('INV-13 同一批工具的传输名互不相撞，且能还原回 canonical 名', () => {
    const plan = toolTransportNames.createPlan(['probe:read', 'probe:write', 'probe-two:read'])
    const transportNames = Object.values(plan.canonicalToProvider)
    expect(new Set(transportNames).size).toBe(transportNames.length)
    const projection = toolTransportNames.createProjection(
      ['probe:read', 'probe:write', 'probe-two:read'],
      ['probe:read', 'probe:write', 'probe-two:read']
    )
    expect(projection.plan.providerToCanonical).toEqual(
      Object.fromEntries(
        Object.entries(plan.canonicalToProvider).map(([canonical, transport]) => [transport, canonical])
      )
    )
  })
})

describe('INV-14 会话租约不抢活着的持有者', () => {
  test('INV-14 持有者进程还活着时抢占被拒；进程已死才允许恢复', () => {
    const current = { sessionId: 'spec', ownerId: 'owner-a', ownerPid: 42, acquiredAt: 1, heartbeatAt: 1 }
    const claim = { sessionId: 'spec', ownerId: 'owner-b', ownerPid: 43 }
    expect(() => resolveAgentSessionLeaseClaim(current, claim, () => true, 100)).toThrow(/正被另一个/u)
    const recovered = resolveAgentSessionLeaseClaim(current, claim, () => false, 100)
    expect(recovered.ownerId).toBe('owner-b')
  })
})

describe('INV-15 归档信封版本不符即拒', () => {
  test('INV-15 format 或 schemaVersion 不认识时拒绝解析，不做宽容降级', () => {
    const envelope = agentSessionKit.createArchiveEnvelope({
      productId: 'spec',
      productSchemaVersion: 1,
      exportedAt: new Date(0).toISOString(),
      sanitized: true,
      session: { id: 'spec' },
      resources: [],
      events: [],
    })
    expect(agentSessionKit.parseArchiveEnvelope(envelope)).toBeTruthy()
    expect(() => agentSessionKit.parseArchiveEnvelope({ ...envelope, format: 'other' })).toThrow()
    expect(() => agentSessionKit.parseArchiveEnvelope({ ...envelope, schemaVersion: 999 })).toThrow()
  })
})

describe('mod 宿主组装面', () => {
  test('INV-5 宿主不给 bundled 时组装器自己用随包内置 mod', async () => {
    const assembly = await agentModHost.assembleAgentMods({ host: createModHost() })
    expect(assembly.report.activated.some((entry) => entry.modId.includes('builtin'))).toBe(true)
  })
})

// ── 工具契约：定义一条工具、说明的两道闸与分节语法、只读判据、挂进内核（INV-23 起，原 @velaros-ai/tool-contract 的 INV-1…INV-6）──

interface ProbeToolContext {
  abortSignal: AbortSignal
  ready: boolean
}

/** 造一份能过全部校验的最小工具定义，调用方只覆盖要测的那几格。 */
function probeToolInput(
  overrides: Partial<DefineToolRuntimeSpecInput<{ text: string }, ProbeToolContext>> = {}
): DefineToolRuntimeSpecInput<{ text: string }, ProbeToolContext> {
  return {
    name: 'probe:echo',
    category: 'probe',
    role: 'inspect',
    summary: '把收到的文本原样回显。',
    suitable: ['确认工具链路通不通'],
    schema: z.strictObject({ text: z.string() }),
    permissions: [],
    execute: async (input) => input.text,
    ...overrides,
  }
}

/** 探针类别的定义函数：走对外的 `toolContracts.createDefiner`，与写工具的一方同一条路。 */
const defineProbeTool = toolContracts.createDefiner<ProbeToolContext>({ categoryOf: () => 'probe' })

describe('INV-23 工具名必须是 canonical 工具 id', () => {
  test('INV-23 不合法的工具名在定义期就抛，进不了注册表', () => {
    expect(() => defineProbeTool(probeToolInput())).not.toThrow()
    expect(() => defineProbeTool(probeToolInput({ name: 'Probe:Echo' }))).toThrow(/canonical/u)
    expect(() => defineProbeTool(probeToolInput({ name: 'probe' }))).toThrow(/canonical/u)
  })
})

describe('INV-24 示例按模型会发的那份 JSON 校验', () => {
  test('INV-24 示例过不了工具自己的 schema 就在定义期抛，报错点名工具', () => {
    expect(() => defineProbeTool(probeToolInput({ examples: [{ text: '你好' }] }))).not.toThrow()
    // undefined 只在内存里成立：序列化后整格消失，必填的 text 就缺了。
    expect(() => defineProbeTool(probeToolInput({ examples: [{ text: undefined }] }))).toThrow(/probe:echo/u)
    expect(() => defineProbeTool(probeToolInput({ examples: [{ text: 1 }] }))).toThrow(/示例/u)
  })
})

describe('INV-25 说明的两道长度闸', () => {
  test('INV-25 硬上限不可豁免，软预算只认两种理由且 note 不能空白', () => {
    const long = (count: number): string => '啊'.repeat(count)
    const { descriptionBudgetChars, descriptionMaxChars } = AgentTuning.toolkit
    const waiver = { reason: 'safety-protocol', note: '整条流程就是护栏' } as const
    expect(() => defineProbeTool(probeToolInput({ summary: long(descriptionMaxChars + 1) }))).toThrow(/硬上限/u)
    expect(() =>
      defineProbeTool(probeToolInput({ summary: long(descriptionMaxChars + 1), descriptionBudgetWaiver: waiver }))
    ).toThrow(/硬上限/u)
    expect(() => defineProbeTool(probeToolInput({ summary: long(descriptionBudgetChars + 1) }))).toThrow(/软预算/u)
    expect(() =>
      defineProbeTool(probeToolInput({ summary: long(descriptionBudgetChars + 1), descriptionBudgetWaiver: waiver }))
    ).not.toThrow()
    expect(() =>
      defineProbeTool(probeToolInput({
        summary: long(descriptionBudgetChars + 1),
        descriptionBudgetWaiver: { reason: 'safety-protocol', note: '   ' },
      }))
    ).toThrow(/note/u)
  })
})

describe('INV-26 说明的分节语法固定', () => {
  test('INV-26 渲染出来的说明一定判为结构化，乱序、缺必填节或空节判非结构化', () => {
    const rendered = renderToolDescription({
      description: '把收到的文本原样回显。',
      suitable: ['确认工具链路通不通'],
      forbidden: ['当成日志工具用'],
      notes: ['回显不改动内容'],
    })
    expect(isStructuredToolDescription(rendered)).toBe(true)
    const parsed = parseStructuredToolDescription(rendered)
    expect(parsed?.suitable).toEqual(['确认工具链路通不通'])
    expect(parsed?.usage).toEqual([])
    // 缺必填的「适合」、分节回头、以及只有标题的空节都判非结构化；对外的整类断言同样拦下。
    expect(isStructuredToolDescription('描述：只有描述')).toBe(false)
    expect(isStructuredToolDescription('描述：x\n\n禁止：\n- a\n\n适合：\n- b')).toBe(false)
    expect(isStructuredToolDescription('描述：x\n\n适合：')).toBe(false)
    expect(() => toolDescriptions.forCategory({ echo: { description: '描述：只有描述' } }, 'probe')).toThrow(/probe\/echo/u)
  })
})

describe('INV-27 只读判据的顺序', () => {
  test('INV-27 readOnly 的判据顺序是 effectKind → 显式 readOnly → role', () => {
    expect(resolveToolReadOnly({ capabilities: { effectKind: 'read' }, readOnly: false, role: 'edit' })).toBe(true)
    expect(resolveToolReadOnly({ capabilities: { effectKind: 'write' }, readOnly: true, role: 'inspect' })).toBe(false)
    expect(resolveToolReadOnly({ readOnly: true, role: 'edit' })).toBe(true)
    expect(resolveToolReadOnly({ role: 'inspect' })).toBe(true)
    expect(resolveToolReadOnly({ role: 'edit' })).toBe(false)
    // 定义出来的工具按同一套判据定出 readOnly。
    expect(defineProbeTool(probeToolInput({ role: 'edit', capabilities: { effectKind: 'read' } })).readOnly).toBe(true)
  })
})

describe('INV-28 内核可调用操作固定四步', () => {
  test('INV-28 严格解析入参、换上内核的 abortSignal、不可用报 UNAVAILABLE；没给解析器一个都不登记', async () => {
    const tool = defineProbeTool(probeToolInput({ execute: async (input, ctx) => `${input.text}:${ctx.ready}` }))
    expect(createToolCallableOperations({ 'probe:echo': tool }, undefined, { label: '探针' })).toEqual({})

    const operations = createToolCallableOperations<ProbeToolContext>(
      { 'probe:echo': tool },
      (_scope, signal) => ({ abortSignal: signal, ready: true }),
      { label: '探针' }
    )
    const controller = new AbortController()
    await expect(
      operations['probe:echo']!.invoke(undefined, { text: '嗨', extra: 1 }, controller.signal)
    ).rejects.toThrow(/入参不合法/u)
    await expect(operations['probe:echo']!.invoke(undefined, '嗨', controller.signal)).rejects.toThrow(/必须是对象/u)
    expect(await operations['probe:echo']!.invoke(undefined, { text: '嗨' }, controller.signal)).toBe('嗨:true')

    const unavailable = createToolCallableOperations<ProbeToolContext>(
      { 'probe:echo': { ...tool, isAvailable: () => false } },
      (_scope, signal) => ({ abortSignal: signal, ready: true }),
      { label: '探针' }
    )
    await expect(
      unavailable['probe:echo']!.invoke(undefined, { text: '嗨' }, controller.signal)
    ).rejects.toThrow(/不可用/u)
  })
})
