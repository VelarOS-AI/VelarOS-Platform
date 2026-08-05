// 域：内置提示词段目录（行为知识三层里 Tier0 的**全集** + 几段宿主无关的 Tier1）。
//
// **Tier0 只有三段**——身份 / 品牌语气 / 内部实现边界。三段都走 `createCorePromptSegment`：
// 不读 facts、不带谓词，渲染结果在构造期即固定，稳定前缀因此在同一会话内逐字不变。
// 任何「按开关或按本轮输入注入」的内容（能力协议、当前时间、用户附加提示词）一律 Tier1，落活动尾。
import { isTrue } from '@velaros-ai/core'

import { createCorePromptSegment, PromptSegmentPriority } from './segments/shared'
import type { PromptSegmentDefinition } from './registry'
import { PromptRegistry } from './registry'

export interface BuiltInPromptOptions {
  /**
   * 宿主为主 Agent 提供的身份说明。
   *
   * 身份属于应用装配，不属于 Agent Runtime；未提供时使用不含产品名称的中性身份。
   */
  primaryAgentIdentity?: string
}

const NeutralPrimaryAgentIdentity =
  '你是宿主应用提供的 AI Agent。请使用当前已注入的能力完成用户目标。'

/** 内置身份和角色 prompt 文案目录。 */
const PromptCatalog = {
  brandVoice: [
    '以完成用户目标为导向；能执行就执行，受限时交付可用部分并说明最小缺口。',
    '先给结论和结果，再补必要上下文与证据。',
    '表达和产物保持简洁、稳定、边界清楚；细节程度服从用户要求。',
  ].join('\n'),
  identities: {
    primaryAgent: NeutralPrimaryAgentIdentity,
  },
} as const

/** 本地时区、分钟精度、格式固定的时间戳（`YYYY-MM-DD HH:mm`）。 */
function formatMinutePrecisionLocalTime(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  ].join(' ')
}

/** 创建内置基础 prompt 段。 */
function createBuiltInPromptSegments(
  options: BuiltInPromptOptions = {}
): PromptSegmentDefinition[] {
  const primaryAgentIdentity =
    options.primaryAgentIdentity?.trim() || PromptCatalog.identities.primaryAgent

  return [
    createIdentityPromptSegment(primaryAgentIdentity),
    createCorePromptSegment({
      id: 'core.brand-voice',
      label: 'Brand Voice',
      source: 'built-in',
      priority: PromptSegmentPriority.brandVoice,
      text: PromptCatalog.brandVoice,
    }),
    createCorePromptSegment({
      id: 'core.internal-implementation-boundary',
      label: 'Internal Implementation Boundary',
      source: 'built-in',
      priority: PromptSegmentPriority.safetyBoundary,
      // 2026-08-06 升 Tier0 并删除 `when: !facts.internalImplementationAccess`：那个 fact
      // 全树**没有任何生产者**（`AgentDeveloperContext` 是已退役的 `never` 兼容位，PromptState
      // 恒填 null），谓词因此恒为真——一条永远成立的判定挂在一条安全纪律上，只会让人以为
      // 「存在关掉它的路径」。边界本身是不可变纪律，属 Tier0。
      text: '仅向用户说明宿主应用已授权公开的信息；内部实现细节留在开发上下文。',
    }),
    {
      id: 'runtime.datetime',
      label: 'Current Date Time',
      tier: 'runtime',
      source: 'runtime',
      priority: 9020,
      // P7-1 粒度钝化：原实现是 `toLocaleString()`（**带秒**且随 locale 变格式）——同一分钟内的
      // 两次请求也会产出不同字节。段本身已随 dynamic 层整体下沉到活动尾（不再挤在稳定前缀与
      // 历史之间，见 `StreamTurn.buildSystemPromptDelivery`），钝化到分钟再消掉尾块自身逐请求
      // 漂移的那一档；格式钉死本地时区的分钟位，与 locale / ICU 数据无关（P7 确定性序列化）。
      render: () => `当前时间：${formatMinutePrecisionLocalTime(new Date())}`,
    },
    // ↓ 三段能力协议曾声明 `stable`，但它们的谓词读的是**逐轮重算**的 facts（本轮是否开启该
    //   能力、最新一条 user 消息是否命中视觉意图正则）。段一开一关，稳定前缀就分叉一次，
    //   连带其后的整段历史掉出 provider 前缀缓存。它们是 Tier1（按会话状态装配）不是 Tier0。
    {
      id: 'runtime.visual-widget-tools',
      label: 'Visual Output Tools',
      tier: 'runtime',
      source: 'built-in',
      retention: 'protected',
      priority: PromptSegmentPriority.capabilityProtocol,
      when: (context) => isTrue(context.facts?.shouldInjectVisualWidgetPrompt),
      render: () =>
        [
          'Widget 能力已开启。',
          '复杂内嵌 SVG、HTML、图表、Canvas、WebGL 或交互组件先读取 skill:widget-visual-output；普通说明使用 Markdown。',
        ].join('\n'),
    },
    {
      id: 'runtime.html-artifact-protocol',
      label: 'HTML Live Preview Protocol',
      tier: 'runtime',
      source: 'built-in',
      retention: 'protected',
      priority: PromptSegmentPriority.capabilityProtocol + 5,
      when: (context) => isTrue(context.facts?.shouldInjectHtmlArtifactPrompt),
      render: () =>
        [
          'HTML 实时预览能力已开启。',
          '轻量流式 HTML/SVG 页面、卡片、落地页、静态内容或轻交互预览先读取 skill:html-artifact-output；普通说明使用 Markdown。',
          '实时预览直接输出 <artifact>/<patch> 流式协议；artifact:produce 仅用于导出可下载资源。',
        ].join('\n'),
    },
    {
      id: 'runtime.visual-rendering-routing',
      label: 'Visual Rendering Routing',
      tier: 'runtime',
      source: 'built-in',
      retention: 'protected',
      priority: PromptSegmentPriority.capabilityProtocol + 10,
      when: (context) =>
        isTrue(context.facts?.shouldInjectVisualWidgetPrompt) &&
        isTrue(context.facts?.shouldInjectHtmlArtifactPrompt),
      render: () =>
        [
          'Widget 与 HTML 实时预览已同时开启，默认只选择最适合当前任务的一种。',
          '简单页面、卡片、落地页、静态内容和轻交互优先使用 HTML 实时预览；复杂图表、Canvas/WebGL、数据驱动界面、多状态或多步交互优先使用 Widget。',
          '只有用户明确要求，或任务确实包含两种用途不同的呈现时，才在同一回复中同时使用两种能力。',
        ].join('\n'),
    },
    {
      // 用户附加提示词刻意留在 Tier1：它可以在会话进行中被设置页改掉，进 Tier0 等于让一次
      // 设置改动把稳定前缀连同整段历史一起作废。
      id: 'user.systemPromptAppend',
      label: 'User Prompt Appendix',
      tier: 'runtime',
      source: 'user',
      priority: PromptSegmentPriority.user,
      render: (context) => {
        const appendix = context.chatConfig?.systemPromptAppend?.trim()
        return appendix ? `用户附加提示词：\n${appendix}` : null
      },
    },
  ]
}

/**
 * Tier0 身份段。
 *
 * 身份是 **builder 作用域**的常量（主 Agent 一份、每个子 Agent 各一份），不是回合作用域，
 * 因此由 `ContextBuilder.withIdentity` 在克隆出的注册表里**重新注册一次**本段，而不是在渲染期
 * 读 `PromptRenderContext.identity`——渲染期读取会给 Tier0 开一条"按上下文变文本"的口子。
 */
function createIdentityPromptSegment(identity: string): PromptSegmentDefinition {
  return createCorePromptSegment({
    id: 'core.identity',
    label: 'Identity',
    source: 'built-in',
    priority: PromptSegmentPriority.identity,
    text: identity,
  })
}

/** 创建带内置段的 SegmentRegistry。 */
function createBuiltInPromptRegistry(options: BuiltInPromptOptions = {}): PromptRegistry {
  return new PromptRegistry(createBuiltInPromptSegments(options))
}

export {
  PromptCatalog as BuiltInPromptCatalog,
  createBuiltInPromptRegistry,
  createBuiltInPromptSegments,
  createIdentityPromptSegment,
}
