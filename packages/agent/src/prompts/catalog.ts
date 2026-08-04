import { isTrue } from '@velaros-ai/core'

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
    {
      id: 'core.identity',
      label: 'Identity',
      stability: 'stable',
      source: 'built-in',
      priority: 0,
      render: (context) => context.identity?.trim() || primaryAgentIdentity,
    },
    {
      id: 'core.brand-voice',
      label: 'Brand Voice',
      stability: 'stable',
      source: 'built-in',
      priority: 10,
      render: () => PromptCatalog.brandVoice,
    },
    {
      id: 'runtime.internal-implementation-boundary',
      label: 'Internal Implementation Boundary',
      stability: 'dynamic',
      source: 'runtime',
      priority: 9010,
      // dev 上下文不注入边界——开发者可自由讨论内部实现。
      when: (context) => !isTrue(context.facts?.internalImplementationAccess),
      render: () => '仅向用户说明宿主应用已授权公开的信息；内部实现细节留在开发上下文。',
    },
    {
      id: 'runtime.datetime',
      label: 'Current Date Time',
      stability: 'dynamic',
      source: 'runtime',
      priority: 9020,
      // P7-1 粒度钝化：原实现是 `toLocaleString()`（**带秒**且随 locale 变格式）——同一分钟内的
      // 两次请求也会产出不同字节。段本身已随 dynamic 层整体下沉到活动尾（不再挤在稳定前缀与
      // 历史之间，见 `StreamTurn.buildSystemPromptDelivery`），钝化到分钟再消掉尾块自身逐请求
      // 漂移的那一档；格式钉死本地时区的分钟位，与 locale / ICU 数据无关（P7 确定性序列化）。
      render: () => `当前时间：${formatMinutePrecisionLocalTime(new Date())}`,
    },
    {
      id: 'runtime.visual-widget-tools',
      label: 'Visual Output Tools',
      stability: 'stable',
      source: 'built-in',
      priority: 700,
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
      stability: 'stable',
      source: 'built-in',
      priority: 705,
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
      stability: 'stable',
      source: 'built-in',
      priority: 710,
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
      id: 'user.systemPromptAppend',
      label: 'User Prompt Appendix',
      stability: 'dynamic',
      source: 'user',
      priority: 10_000,
      render: (context) => {
        const appendix = context.chatConfig?.systemPromptAppend?.trim()
        return appendix ? `用户附加提示词：\n${appendix}` : null
      },
    },
  ]
}

/** 创建带内置段的 SegmentRegistry。 */
function createBuiltInPromptRegistry(options: BuiltInPromptOptions = {}): PromptRegistry {
  return new PromptRegistry(createBuiltInPromptSegments(options))
}

export { PromptCatalog as BuiltInPromptCatalog, createBuiltInPromptRegistry, createBuiltInPromptSegments }
