import { describe, expect, test } from 'bun:test'

import {
  type AgentModHostProfile,
  AgentModLoader,
  AgentModRegistry,
  AgentModSeamDispatcher,
  AgentModStaleSnapshotError,
  assembleAgentMods,
  BuiltinAgentModId,
  collectBuiltinAgentModTools,
  composeAgentModSpaces,
  createBuiltinAgentModPackage,
  createBuiltInPromptSegments,
  listExecutionModes,
  projectAgentModExecutionModes,
  projectAgentModPromptSegments,
  projectAgentModTools,
} from '../src'
import type {
  AgentModContributionAxisName,
  AgentModManifest,
} from '../src/protocol'
import { AgentModManifestSchemaVersion, parseAgentModManifest } from '../src/protocol'

const AllAxes: readonly AgentModContributionAxisName[] = [
  'tools',
  'toolCategories',
  'promptSegments',
  'skills',
  'spaces',
  'subAgentTypes',
  'turnContextSources',
  'executionModes',
  'hooks',
]

function createHost(
  overrides: Partial<AgentModHostProfile> = {}
): AgentModHostProfile {
  return {
    hostId: 'probe-host',
    velarosVersion: '1.4.2',
    agentApiVersion: '1.0.0',
    supportedAxes: AllAxes,
    allowedTrustLevels: ['bundled-official', 'marketplace-signed', 'local-dev'],
    ...overrides,
  }
}

function createManifest(overrides: Partial<AgentModManifest> = {}): AgentModManifest {
  return {
    id: 'probe.mod',
    version: '0.1.0',
    manifestSchemaVersion: AgentModManifestSchemaVersion,
    engines: { velaros: '^1.0.0' },
    trust: 'local-dev',
    contributes: {},
    ...overrides,
  } as AgentModManifest
}

describe('agent mod loader', () => {
  test('space availability does not implicitly pin every tool schema as resident', () => {
    const registry = new AgentModRegistry()
    registry.beginRegistration()
    registry.register('spaces', {
      axis: 'spaces',
      modId: 'probe.mod',
      key: 'project',
      declaration: {
        id: 'project',
        descriptor: { label: 'Project' },
        identityStrategy: 'path',
      },
      payload: null,
    })
    registry.register('tools', {
      axis: 'tools',
      modId: 'probe.mod',
      key: 'probe:available',
      declaration: {
        name: 'probe:available',
        categoryId: 'probe-files',
        availableInSpaces: ['project'],
      },
      payload: null,
    })
    registry.register('tools', {
      axis: 'tools',
      modId: 'probe.mod',
      key: 'probe:resident',
      declaration: {
        name: 'probe:resident',
        categoryId: 'probe-control',
        residentInSpaces: ['project'],
      },
      payload: null,
    })
    registry.endRegistration()

    const [space] = composeAgentModSpaces(registry.snapshot())
    expect(space?.toolCategoryIds).toEqual(['probe-files', 'probe-control'])
    expect(space?.residentToolNames).toEqual(['probe:resident'])
  })

  test('装载随包内置 mod 后，工具与提示词段逐项等价于直接枚举（自食狗粮零变化）', () => {
    const loader = new AgentModLoader({ host: createHost() })
    const builtin = createBuiltinAgentModPackage()
    const report = loader.load([builtin])

    expect(report.rejected).toEqual([])
    expect(report.activated).toHaveLength(1)
    expect(report.activated[0]?.modId).toBe(BuiltinAgentModId)
    expect(report.activated[0]?.status).toBe('active')

    const snapshot = loader.snapshot()

    // ① 工具：清单逐项相等，且**载荷对象同一性**保持（装载不复制不包装）。
    const expectedTools = collectBuiltinAgentModTools()
    const loadedTools = projectAgentModTools(snapshot)
    expect(Object.keys(loadedTools).sort()).toEqual(Object.keys(expectedTools).sort())
    for (const [name, tool] of Object.entries(expectedTools)) {
      expect(loadedTools[name]).toBe(tool)
    }

    // ② 提示词段：与内置单源（createBuiltInPromptSegments）逐项同 id 同序同稳定性，
    //    且装载产物就是本包绑定的那批定义对象本身（不复制不包装）。
    const expectedSegments = createBuiltInPromptSegments()
    const loadedSegments = projectAgentModPromptSegments(snapshot)
    expect(loadedSegments.map((segment) => segment.id)).toEqual(
      expectedSegments.map((segment) => segment.id)
    )
    expect(loadedSegments.map((segment) => segment.stability)).toEqual(
      expectedSegments.map((segment) => segment.stability)
    )
    expect(loadedSegments.map((segment) => segment.priority)).toEqual(
      expectedSegments.map((segment) => segment.priority)
    )
    for (const segment of loadedSegments) {
      expect(segment).toBe(builtin.bindings.promptSegments?.[segment.id])
    }

    // ③ 执行模式：官方三模式经同一 Loader 装载后同一性保持。
    const expectedModes = listExecutionModes()
    const loadedModes = projectAgentModExecutionModes(snapshot)
    expect(loadedModes.map((mode) => mode.id)).toEqual(
      expectedModes.map((mode) => mode.id)
    )
    for (const [index, mode] of expectedModes.entries()) {
      expect(loadedModes[index]).toBe(mode)
    }
  })

  test('宿主组装入口缺省恒加载内置 mod，并把不含 Agent 轴的 pack 留痕跳过', async () => {
    const { report } = await assembleAgentMods({
      host: createHost(),
      packs: [
        {
          id: 'pack.other',
          version: '1.0.0',
          enabled: true,
          provides: ['velaros.other'],
          specifier: '/packs/other',
        },
        {
          id: 'pack.disabled',
          version: '1.0.0',
          enabled: false,
          provides: ['velaros.agent'],
          specifier: '/packs/disabled',
        },
      ],
      reader: {
        readManifest: () => {
          throw new Error('不应读取被跳过的 pack')
        },
      },
    })

    expect(report.activated.map((state) => state.modId)).toEqual([BuiltinAgentModId])
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['mod.pack-not-agent-axis', 'mod.pack-disabled'])
    )
  })

  test('pack manifest 读不出即拒载并留可读诊断，不静默跳过', async () => {
    const { report } = await assembleAgentMods({
      host: createHost(),
      bundled: [],
      packs: [
        {
          id: 'pack.broken',
          version: '1.0.0',
          enabled: true,
          provides: ['velaros.agent'],
          specifier: '/packs/broken',
        },
      ],
      reader: {
        readManifest: () => {
          throw new Error('ENOENT')
        },
      },
    })

    expect(report.activated).toEqual([])
    const diagnostic = report.diagnostics.find(
      (item) => item.code === 'mod.pack-unreadable'
    )
    expect(diagnostic?.message).toContain('velaros.mod.json')
    expect(diagnostic?.message).toContain('ENOENT')
  })

  test('读 velaros.mod.json 取 agent 节装载，module/ui 两节读都不读', async () => {
    const { report } = await assembleAgentMods({
      host: createHost(),
      bundled: [],
      packs: [
        {
          id: 'pack.enveloped',
          version: '1.0.0',
          enabled: true,
          provides: ['velaros.agent'],
          specifier: '/packs/enveloped',
        },
      ],
      reader: {
        readManifest: ({ manifestFileName }) => {
          expect(manifestFileName).toBe('velaros.mod.json')
          return {
            module: {
              id: 'probe.mod',
              version: '0.1.0',
              apiVersion: 1,
              provides: ['velaros.agent'],
            },
            agent: createManifest({
              contributes: { skills: [{ id: 'skill.one', name: 'One', spaces: ['system'] }] },
            }),
            // 壳级节：agent 侧不解析，它的形状怎么变都不该影响装载。
            ui: { pages: [{ id: 'page.one', renderer: 'whatever' }] },
          }
        },
      },
    })

    expect(report.rejected).toEqual([])
    expect(report.activated.map((state) => state.modId)).toEqual(['probe.mod'])
    expect(report.activated[0]?.activeAxes).toEqual(['skills'])
  })

  test('「读不出文件」与「文件在但没有 agent 节」是两个不同诊断', async () => {
    const { report } = await assembleAgentMods({
      host: createHost(),
      bundled: [],
      packs: [
        {
          id: 'pack.no-agent-section',
          version: '1.0.0',
          enabled: true,
          provides: ['velaros.agent'],
          specifier: '/packs/no-agent-section',
        },
      ],
      reader: {
        readManifest: () => ({
          module: {
            id: 'probe.mod',
            version: '0.1.0',
            apiVersion: 1,
            provides: ['velaros.agent'],
          },
        }),
      },
    })

    expect(report.activated).toEqual([])
    const codes = report.diagnostics.map((item) => item.code)
    expect(codes).toContain('mod.pack-no-agent-section')
    expect(codes).not.toContain('mod.pack-unreadable')
  })

  test('信封本身非法（缺 module 节）拒载并留信封诊断', async () => {
    const { report } = await assembleAgentMods({
      host: createHost(),
      bundled: [],
      packs: [
        {
          id: 'pack.bad-envelope',
          version: '1.0.0',
          enabled: true,
          provides: ['velaros.agent'],
          specifier: '/packs/bad-envelope',
        },
      ],
      reader: {
        readManifest: () => ({ agent: createManifest() }),
      },
    })

    expect(report.activated).toEqual([])
    const diagnostic = report.diagnostics.find(
      (item) => item.code === 'mod.envelope-invalid'
    )
    expect(diagnostic?.modId).toBe('pack.bad-envelope')
  })
})

describe('agent mod validate/resolve 拒载语义', () => {
  test('非法 manifest 给可读诊断，不静默降级', () => {
    const loader = new AgentModLoader({ host: createHost() })
    const report = loader.load([
      { source: 'pack', origin: '/packs/bad', manifest: { id: 'bad' } },
    ])

    expect(report.activated).toEqual([])
    expect(report.rejected).toHaveLength(1)
    expect(report.rejected[0]?.diagnostics[0]?.code).toBe('mod.manifest-invalid')
  })

  test('未知贡献点被拒载，而不是被静默丢弃', () => {
    const loader = new AgentModLoader({ host: createHost() })
    const report = loader.load([
      {
        source: 'pack',
        origin: '/packs/unknown-axis',
        manifest: {
          ...createManifest(),
          contributes: { pages: [{ id: 'p1' }] },
        },
      },
    ])

    expect(report.activated).toEqual([])
    expect(report.rejected[0]?.diagnostics[0]?.code).toBe('mod.manifest-invalid')
  })

  test('engines 双轴不兼容即拒载', () => {
    const loader = new AgentModLoader({ host: createHost() })
    const report = loader.load([
      {
        source: 'pack',
        origin: '/packs/old',
        manifest: createManifest({ engines: { velaros: '^0.9.0' } }),
      },
      {
        source: 'pack',
        origin: '/packs/future-agent',
        manifest: createManifest({
          id: 'probe.agent-axis',
          engines: { velaros: '^1.0.0', agent: '>=2.0.0' },
        }),
      },
    ])

    expect(report.activated).toEqual([])
    expect(
      report.rejected.every((item) =>
        item.diagnostics.some((diagnostic) => diagnostic.code === 'mod.engine-incompatible')
      )
    ).toBe(true)
  })

  test('信任级不在宿主允许集合内即拒载（fail-closed 缺省只放行随包官方）', () => {
    const loader = new AgentModLoader({
      host: createHost({ allowedTrustLevels: undefined }),
    })
    const report = loader.load([
      { source: 'pack', origin: '/packs/dev', manifest: createManifest() },
    ])

    expect(report.rejected[0]?.diagnostics[0]?.code).toBe('mod.trust-not-allowed')
  })

  test('工具名冲突拒载后来者，先到者不受影响', () => {
    const withTool = (id: string) => ({
      source: 'pack' as const,
      origin: `/packs/${id}`,
      manifest: createManifest({
        id,
        contributes: { tools: [{ name: 'probe:tool' }] },
      }),
      bindings: { tools: { 'probe:tool': { name: 'probe:tool' } as never } },
    })
    const loader = new AgentModLoader({ host: createHost() })
    const report = loader.load([withTool('probe.first'), withTool('probe.second')])

    expect(report.activated.map((state) => state.modId)).toEqual(['probe.first'])
    expect(report.rejected[0]?.diagnostics[0]?.code).toBe('mod.tool-name-conflict')
  })

  test('工具轴缺运行态绑定即拒载，不降级成空贡献', () => {
    const loader = new AgentModLoader({ host: createHost() })
    const report = loader.load([
      {
        source: 'pack',
        origin: '/packs/no-binding',
        manifest: createManifest({ contributes: { tools: [{ name: 'probe:tool' }] } }),
      },
    ])

    expect(report.rejected[0]?.diagnostics[0]?.code).toBe('mod.binding-missing')
  })
})

describe('partial activation', () => {
  test('宿主不支持的轴缺席、mod 仍以 partial 激活并留诊断', () => {
    const loader = new AgentModLoader({
      host: createHost({ supportedAxes: ['tools', 'promptSegments'] }),
    })
    const report = loader.load([
      {
        source: 'pack',
        origin: '/packs/partial',
        manifest: createManifest({
          contributes: {
            promptSegments: [
              { id: 'seg.a', stability: 'dynamic', priority: 10, text: '段正文' },
            ],
            spaces: [
              {
                id: 'space.a',
                descriptor: { label: '演示' },
                identityStrategy: 'ordinal',
              },
            ],
          },
        }),
      },
    ])

    expect(report.activated).toHaveLength(1)
    expect(report.activated[0]?.status).toBe('partial')
    expect(report.activated[0]?.absentAxes).toEqual(['spaces'])
    expect(report.diagnostics.some((item) => item.code === 'mod.axis-absent')).toBe(true)
    expect(loader.snapshot().spaces).toEqual([])
    expect(loader.snapshot().promptSegments).toHaveLength(1)
  })

  test('requiredAxes 不被支持即拒载，不做残废激活', () => {
    const loader = new AgentModLoader({
      host: createHost({ supportedAxes: ['tools'] }),
    })
    const report = loader.load([
      {
        source: 'pack',
        origin: '/packs/required',
        manifest: createManifest({
          requiredAxes: ['spaces'],
          contributes: {
            spaces: [
              {
                id: 'space.a',
                descriptor: { label: '演示' },
                identityStrategy: 'ordinal',
              },
            ],
          },
        }),
      },
    ])

    expect(report.activated).toEqual([])
    expect(report.rejected[0]?.diagnostics[0]?.code).toBe(
      'mod.required-axis-unsupported'
    )
  })
})

describe('注册表两阶段与 generation', () => {
  test('运行阶段写入即抛；快照按 generation 冻结并 stale-reject', () => {
    const loader = new AgentModLoader({ host: createHost() })
    loader.load([createBuiltinAgentModPackage()])

    const snapshot = loader.snapshot()
    expect(loader.registry.isStale(snapshot)).toBe(false)
    expect(() =>
      loader.registry.register('spaces', {
        axis: 'spaces',
        modId: 'probe',
        key: 'k',
        declaration: {} as never,
        payload: null,
      })
    ).toThrow(/registration 阶段/u)

    loader.deactivate(BuiltinAgentModId)
    expect(loader.registry.isStale(snapshot)).toBe(true)
    expect(() => loader.registry.assertFresh(snapshot)).toThrow(
      AgentModStaleSnapshotError
    )
    expect(loader.snapshot().tools).toEqual([])
  })
})

describe('seam 派发器', () => {
  test('event 是标准字段，旧 seam 输入只作解析别名', () => {
    const modern = parseAgentModManifest({
      ...createManifest(),
      contributes: {
        hooks: [{ id: 'modern', event: 'session:start' }],
      },
    })
    const legacy = parseAgentModManifest({
      ...createManifest(),
      contributes: {
        hooks: [{ id: 'legacy', seam: 'session:start' }],
      },
    })

    expect(modern.ok).toBe(true)
    expect(legacy.ok).toBe(true)
    if (!modern.ok || !legacy.ok) return
    expect(modern.manifest.contributes.hooks?.[0]).toEqual({
      id: 'modern',
      event: 'session:start',
      mode: 'blocking',
    })
    expect(legacy.manifest.contributes.hooks?.[0]).toEqual({
      id: 'legacy',
      event: 'session:start',
      mode: 'blocking',
    })
  })

  test('matcher 在派发器单点生效，编译期与外部 binding 不各自解释', async () => {
    const dispatcher = new AgentModSeamDispatcher()
    let calls = 0
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe',
      id: 'matched',
      event: 'tool-call:before',
      matcher: { toolNames: ['probe:allowed'] },
      handler: () => {
        calls += 1
        return { args: { matched: true } }
      },
    })
    dispatcher.seal()

    const skipped = await dispatcher.dispatchToolCallBefore({
      toolCallId: 'call-skipped',
      toolName: 'probe:other',
      args: {},
      sessionId: null,
    })
    const matched = await dispatcher.dispatchToolCallBefore({
      toolCallId: 'call-matched',
      toolName: 'probe:allowed',
      args: {},
      sessionId: null,
    })

    expect(skipped).toEqual({})
    expect(matched.args).toEqual({ matched: true })
    expect(calls).toBe(1)
  })

  test('blocking Hook 超时后 abort signal 并隔离，主链继续', async () => {
    const dispatcher = new AgentModSeamDispatcher()
    let aborted = false
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe',
      id: 'slow',
      event: 'tool-call:before',
      timeoutMs: 100,
      handler: (_event, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            aborted = true
            resolve({ args: { tooLate: true } })
          }, { once: true })
        }),
    })
    dispatcher.seal()

    const outcome = await dispatcher.dispatchToolCallBefore({
      toolCallId: 'call-timeout',
      toolName: 'probe:slow',
      args: {},
      sessionId: null,
    })

    expect(outcome).toEqual({})
    expect(aborted).toBe(true)
    expect(dispatcher.listDiagnostics().at(-1)?.code).toBe('mod.hook-timeout')
  })

  test('background Hook 只观察，返回的拦截/改写结果不进主链', async () => {
    const dispatcher = new AgentModSeamDispatcher()
    let observed = false
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe',
      id: 'observer',
      event: 'tool-call:before',
      mode: 'background',
      handler: () => {
        observed = true
        return { block: { reason: 'must be ignored' }, args: { ignored: true } }
      },
    })
    dispatcher.seal()

    const outcome = await dispatcher.dispatchToolCallBefore({
      toolCallId: 'call-background',
      toolName: 'probe:observe',
      args: {},
      sessionId: null,
    })
    await Promise.resolve()

    expect(observed).toBe(true)
    expect(outcome).toEqual({})
  })

  test('钩子异常被隔离成诊断，不打断派发链', async () => {
    const dispatcher = new AgentModSeamDispatcher()
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe.a',
      id: 'boom',
      event: 'tool-call:before',
      priority: 1,
      handler: () => {
        throw new Error('钩子炸了')
      },
    })
    dispatcher.register({
      modId: 'probe.b',
      id: 'rewrite',
      event: 'tool-call:before',
      priority: 2,
      handler: () => ({ args: { rewritten: true } }),
    })
    dispatcher.seal()

    const outcome = await dispatcher.dispatchToolCallBefore({
      toolCallId: 'call-1',
      toolName: 'probe_tool',
      args: {},
      sessionId: null,
    })

    expect(outcome.args).toEqual({ rewritten: true })
    expect(dispatcher.listDiagnostics()[0]?.code).toBe('mod.seam-handler-failed')
  })

  test('拦下短路后续钩子；结果面没有任何「放行」语义', async () => {
    const dispatcher = new AgentModSeamDispatcher()
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe.a',
      id: 'block',
      event: 'tool-call:before',
      priority: 1,
      handler: () => ({ block: { reason: '策略拒绝' } }),
    })
    let laterRan = false
    dispatcher.register({
      modId: 'probe.b',
      id: 'later',
      event: 'tool-call:before',
      priority: 2,
      handler: () => {
        laterRan = true
      },
    })
    dispatcher.seal()

    const outcome = await dispatcher.dispatchToolCallBefore({
      toolCallId: 'call-1',
      toolName: 'probe_tool',
      args: {},
      sessionId: null,
    })

    expect(outcome.block?.reason).toBe('策略拒绝')
    expect(laterRan).toBe(false)
    expect(Object.keys(outcome)).not.toContain('allow')
  })

  test('封存后注册即抛（两阶段纪律）', () => {
    const dispatcher = new AgentModSeamDispatcher()
    dispatcher.seal()
    expect(() =>
      dispatcher.register({
        modId: 'probe',
        id: 'late',
        event: 'turn:start',
        handler: () => undefined,
      })
    ).toThrow(/已封存/u)
  })

  test('同步 seam 的钩子返回 Promise 判契约违规，结果被忽略并留诊断', () => {
    const dispatcher = new AgentModSeamDispatcher()
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe',
      id: 'async',
      event: 'turn-context:assemble',
      handler: (() =>
        Promise.resolve({ append: [{ id: 'x', text: 'x' }] })) as never,
    })
    dispatcher.seal()

    const outcome = dispatcher.dispatchTurnContextAssemble({
      stableSegments: [],
      dynamicSegments: [],
    })

    expect(outcome.append).toBeUndefined()
    expect(dispatcher.listDiagnostics()[0]?.code).toBe(
      'mod.seam-sync-contract-violation'
    )
  })

  test('异步宿主入口可承载 command 形态的 turn-context Hook', async () => {
    const dispatcher = new AgentModSeamDispatcher()
    dispatcher.beginRegistration()
    dispatcher.register({
      modId: 'probe',
      id: 'async-context',
      event: 'turn-context:assemble',
      handler: async () => ({ append: [{ id: 'external', text: 'context' }] }),
    })
    dispatcher.seal()

    const outcome = await dispatcher.dispatchTurnContextAssembleAsync({
      stableSegments: [],
      dynamicSegments: [],
    })

    expect(outcome.append).toEqual([{
      id: 'probe.external',
      text: 'context',
    }])
    expect(dispatcher.listDiagnostics()).toEqual([])
  })

  test('mod 钩子经 hooks 轴装载后进入派发链', async () => {
    const loader = new AgentModLoader({ host: createHost() })
    const seen: string[] = []
    const report = loader.load([
      {
        source: 'pack',
        origin: '/packs/hook',
        manifest: createManifest({
          contributes: {
            hooks: [{ id: 'trace', event: 'session:start', priority: 5 }],
          },
        }),
        bindings: {
          hooks: {
            trace: (event) => {
              seen.push(JSON.stringify(event))
            },
          },
        },
      },
    ])

    expect(report.rejected).toEqual([])
    await loader.seams.dispatchSessionLifecycle({
      phase: 'start',
      executionId: null,
      sessionId: 'session-1',
      status: null,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('session-1')
  })
})
