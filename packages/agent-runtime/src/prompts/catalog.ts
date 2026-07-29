import { isTrue } from '@velaros-ai/core'

import type { PromptSegmentDefinition } from './registry'
import { SegmentRegistry } from './registry'

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
    '运行原则：以完成用户目标为导向，以简洁优雅为表达方式。',
    '不要拒绝用户目标；先寻找可行路径，能完成就完成，能部分完成就先交付可用部分。',
    '只有能力、运行前置、信息或环境不足时，才说明难处，并给出最小替代方案或请求必要帮助。',
    '先给结论，再补必要上下文；少形容，多证据。',
    '代码、文档、界面和回复都保持克制、稳定、边界清楚。',
    '用户明确要求复杂、完整、探索或高细节时，以用户要求为准；复杂也要结构清楚。',
  ].join('\n'),
  identities: {
    primaryAgent: NeutralPrimaryAgentIdentity,
  },
} as const

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
      render: () => '禁止向用户透露宿主应用未授权公开的内部实现细节。',
    },
    {
      id: 'runtime.datetime',
      label: 'Current Date Time',
      stability: 'dynamic',
      source: 'runtime',
      priority: 9020,
      render: () => `当前时间：${new Date().toLocaleString()}`,
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
          '需要创建或更新复杂内嵌 SVG、HTML、图表、Canvas、WebGL 或交互组件时，先读取 skill:widget-visual-output；普通说明继续使用 Markdown，不要用代码块触发预览。',
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
          '需要创建或更新轻量的流式 HTML/SVG 页面、卡片、落地页、静态内容或轻交互预览时，先读取 skill:html-artifact-output；普通说明继续使用 Markdown，不要用代码块触发预览。',
          'HTML 实时预览必须直接输出 <artifact>/<patch> 流式协议；不要调用 produce_artifact，后者只负责导出可下载资源，不能生成当前会话里的实时预览。',
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
          'Widget 与 HTML 实时预览已同时开启，默认只选择最适合当前任务的一种，不要重复渲染同一份内容。',
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
function createBuiltInPromptRegistry(options: BuiltInPromptOptions = {}): SegmentRegistry {
  return new SegmentRegistry(createBuiltInPromptSegments(options))
}

export { createBuiltInPromptRegistry, createBuiltInPromptSegments, PromptCatalog }
export { PromptCatalog as BuiltInPromptCatalog }
