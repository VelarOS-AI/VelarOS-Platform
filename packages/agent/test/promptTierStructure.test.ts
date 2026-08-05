/**
 * 行为知识三层（Tier0 核心 / Tier1 运行态 / Tier2 技能）的结构断言电池。
 *
 * 这一组锁的是「分层是结构，不是先例」：
 *  ① Tier0 是稳定前缀的全部内容，且**逐轮字节不变**——任何按 facts 开关的段都不许进去；
 *  ② 曾经声明 `stable` 却按本轮输入开关的能力协议段（HTML 实时预览 / Widget）已下沉 Tier1；
 *  ③ 技能段是 Tier2，落活动尾且 `protected`（预算裁剪不得吞掉用户显式选中的技能）；
 *  ④ 装配顺序是 (tier, priority, id) 的纯函数——注册顺序改变不改变输出字节；
 *  ⑤ mod 贡献段一律 Tier1，manifest 里写 `stability: 'stable'` 也进不了稳定前缀。
 */
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { ContextBuilder } from '../src/agent/ContextBuilder'
import { projectAgentModPromptSegments } from '../src/mods/AgentModProjection'
import { AgentModSeamDispatcher } from '../src/mods/AgentModSeams'
import {
  createBuiltInPromptRegistry,
  createBuiltInPromptSegments,
  createSelectedSkillPromptSegment,
  createTextPromptSegment,
  PromptRegistry,
  PromptSegmentPriority,
} from '../src/prompts'

/** Tier0 的全集。改这张表 = 改稳定前缀的内容，必须是有意的。 */
const CoreTierSegmentIds = [
  'core.identity',
  'core.brand-voice',
  'core.internal-implementation-boundary',
]

function buildPrompt(facts: Record<string, unknown> = {}): ReturnType<ContextBuilder['build']> {
  return new ContextBuilder(createBuiltInPromptRegistry()).build(undefined, { facts })
}

void describe('Tier0 是稳定前缀的全部内容', () => {
  void test('稳定段恰好等于登记的 Tier0 全集', () => {
    const built = buildPrompt()
    const stableIds = built.segments
      .filter((segment) => segment.stability === 'stable')
      .map((segment) => segment.id)

    assert.deepEqual(stableIds.sort(), [...CoreTierSegmentIds].sort())
  })

  void test('无论本轮 facts 怎么变，稳定前缀逐字不变', () => {
    // 这三组 facts 覆盖了历史上会让 stable 段一开一关的全部开关：能力开启 + 视觉意图命中。
    const prefixes = [
      {},
      { shouldInjectHtmlArtifactPrompt: true },
      { shouldInjectHtmlArtifactPrompt: true, shouldInjectVisualWidgetPrompt: true },
    ].map((facts) => {
      const built = buildPrompt(facts)
      return built.systemPrompt.slice(0, built.stableCutoff)
    })

    assert.equal(prefixes[0], prefixes[1])
    assert.equal(prefixes[1], prefixes[2])
  })

  void test('段改名后，存量 override 仍按旧 id 生效（否则用户关掉的段悄悄复活）', () => {
    // 段 id 是持久化配置的主键：内部实现边界段升 Tier0 时 `runtime.*` 改成了 `core.*`，
    // 磁盘上写着旧 id 的 override 若不归一，失配的表现是「那段又回来了」且毫无线索。
    const composed = createBuiltInPromptRegistry().compose({
      overrides: [
        {
          id: 'runtime.internal-implementation-boundary',
          enabled: false,
          reason: null,
          updatedAt: 0,
        },
      ],
    })

    assert.ok(
      composed.skipped.some((entry) => entry.id === 'core.internal-implementation-boundary'),
      '旧 id 的 override 必须归一到现 id 上并关停该段'
    )
    assert.ok(
      !composed.stableParts.some((entry) => entry.id === 'core.internal-implementation-boundary')
    )
  })

  void test('绕过工厂手写的带谓词 Tier0 段，注册面机械拒收', () => {
    // 工厂不暴露 `when` 只是工厂的不变量；注册面收裸定义，`{ tier:'core', when }` 完全可表达。
    // 这条锁的是「拦截是门不是约定」——静态注册与 provider 动态生成两个入口都要拦。
    const corePredicateSegment = {
      id: 'core.smuggled',
      tier: 'core' as const,
      source: 'test',
      priority: 0,
      when: () => true,
      render: () => '偷渡进稳定前缀的按开关内容',
    }

    assert.throws(() => new PromptRegistry().register(corePredicateSegment), /激活谓词/u)

    const registry = new PromptRegistry()
    registry.registerProvider({ id: 'smuggler', load: () => [corePredicateSegment] })
    assert.throws(() => registry.compose(), /激活谓词/u)
  })

  void test('Tier0 段构造期就不接受谓词——按开关的内容在类型上进不了这一层', () => {
    // createCorePromptSegment 不暴露 `when`；这里断言内置 Tier0 段确实没有谓词，
    // 免得有人绕过工厂手写一份带 when 的 core 段。
    const coreDefinitions = createBuiltInPromptSegments().filter(
      (definition) => definition.tier === 'core'
    )

    assert.equal(coreDefinitions.length, CoreTierSegmentIds.length)
    for (const definition of coreDefinitions) {
      assert.equal(definition.when, undefined, `Tier0 段 ${definition.id} 不许带激活谓词`)
    }
  })
})

void describe('能力协议段与技能段已下沉活动尾', () => {
  void test('HTML 实时预览协议段是 Tier1（开启时进活动尾，不动前缀）', () => {
    const off = buildPrompt()
    const on = buildPrompt({ shouldInjectHtmlArtifactPrompt: true })
    const segment = on.segments.find((entry) => entry.id === 'runtime.html-artifact-protocol')

    assert.ok(segment, '开启后该段必须在场')
    assert.equal(segment.stability, 'dynamic')
    assert.ok(on.systemPrompt.length > off.systemPrompt.length)
    // 前缀一字未动：段的出现只加长活动尾。
    assert.equal(on.systemPrompt.slice(0, on.stableCutoff), off.systemPrompt.slice(0, off.stableCutoff))
  })

  void test('Widget 协议段的 fact 现在真的有生产者驱动（不再是永不命中的死段）', () => {
    const built = buildPrompt({ shouldInjectVisualWidgetPrompt: true })

    assert.ok(built.segments.some((entry) => entry.id === 'runtime.visual-widget-tools'))
  })

  void test('技能段是 Tier2 且 protected：预算裁剪不得把它裁掉', () => {
    const registry = createBuiltInPromptRegistry()
    registry.register(createSelectedSkillPromptSegment('# 命中 Skill\n- skill:demo'))
    const built = new ContextBuilder(registry).build(
      undefined,
      {},
      // 预算给到只够放下 XML 骨架，逼裁剪器把所有可裁的段都吃掉。
      { promptBudget: { profile: 'compact', maxChars: 1 } }
    )

    const skillSegment = built.segments.find((entry) => entry.id === 'skill.active')
    assert.ok(skillSegment, '用户显式选中的技能索引不许被预算静默丢弃')
    assert.equal(skillSegment.stability, 'dynamic')
  })
})

void describe('装配顺序是 (tier, priority, id) 的纯函数', () => {
  void test('注册顺序不改变输出字节', () => {
    const segments = [
      createTextPromptSegment({
        id: 'runtime.zebra',
        label: 'Zebra',
        source: 'test',
        priority: PromptSegmentPriority.runtime,
        text: 'zebra',
      }),
      createTextPromptSegment({
        id: 'runtime.alpha',
        label: 'Alpha',
        source: 'test',
        priority: PromptSegmentPriority.runtime,
        text: 'alpha',
      }),
      createSelectedSkillPromptSegment('# 命中 Skill\n- skill:demo'),
    ]
    const forward = new ContextBuilder(new PromptRegistry(segments)).build()
    const reversed = new ContextBuilder(new PromptRegistry([...segments].reverse())).build()

    assert.equal(forward.systemPrompt, reversed.systemPrompt)
    // 同 priority 走码元序；Tier2 恒排在全部 Tier1 之后。
    assert.ok(forward.systemPrompt.indexOf('alpha') < forward.systemPrompt.indexOf('zebra'))
    assert.ok(forward.systemPrompt.indexOf('zebra') < forward.systemPrompt.indexOf('skill:demo'))
  })

  void test('withIdentity 替换 Tier0 身份段，且不丢 mod 接缝', () => {
    // 必须用**真派发器**：哑桩（`{ has: () => false }`）让「不丢接缝」这半句零断言——
    // 把 withIdentity 还原成丢 seams 的旧实现，哑桩版本仍然全绿。接缝丢没丢，唯一看得见的
    // 表现就是派生 builder 上那个追加段在不在。
    const seams = new AgentModSeamDispatcher()
    seams.register({
      modId: 'demo-mod',
      id: 'append-turn-context',
      seam: 'turn-context:assemble',
      handler: () => ({ append: [{ id: 'seam-segment', text: '接缝追加的活动尾段' }] }),
    })
    const builder = new ContextBuilder(createBuiltInPromptRegistry(), seams)
    const built = builder.withIdentity('你是 Acme 研究助手。').build()
    const identity = built.segments.find((entry) => entry.id === 'core.identity')

    assert.equal(identity?.text, '你是 Acme 研究助手。')
    assert.equal(identity?.stability, 'stable')
    // 接缝跟着克隆走：派发器 id 前缀由 mod 侧加，段落进活动尾且计入 prompt 字节。
    const seamSegment = built.segments.find((entry) => entry.id === 'demo-mod.seam-segment')
    assert.ok(seamSegment, 'withIdentity 派生出的 builder 必须仍带着 seams')
    assert.equal(seamSegment.stability, 'dynamic')
    assert.equal(seamSegment.source, 'mod')
    assert.ok(built.systemPrompt.includes('接缝追加的活动尾段'))
    // 原 builder 不受影响（克隆隔离）。
    assert.notEqual(
      builder.build().segments.find((entry) => entry.id === 'core.identity')?.text,
      '你是 Acme 研究助手。'
    )
  })
})

void describe('mod 贡献段进不了稳定前缀', () => {
  function projectDemoSegment(
    declaration: Record<string, unknown>
  ): ReturnType<typeof projectAgentModPromptSegments>[number] | undefined {
    const [segment] = projectAgentModPromptSegments({
      promptSegments: [
        { modId: 'demo-mod', key: 'demo.segment', declaration, payload: null },
      ],
    } as never)
    return segment
  }

  void test('manifest 声明 stable 也一律落 Tier1', () => {
    const segment = projectDemoSegment({
      id: 'demo.segment',
      label: 'Demo',
      stability: 'stable',
      priority: 1_500,
      text: '第三方文本',
    })

    assert.equal(segment?.tier, 'runtime')
  })

  void test('manifest 自报 protected 也一律落 normal（预算免死金牌不外发）', () => {
    const segment = projectDemoSegment({
      id: 'demo.segment',
      stability: 'dynamic',
      priority: 1_500,
      retention: 'protected',
      text: '第三方文本',
    })

    assert.equal(segment?.retention, 'normal')
  })
})
