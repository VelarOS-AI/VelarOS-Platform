// 域：内置提示词段目录（行为知识三层里 Tier0 的**全集** + 几段宿主无关的 Tier1）。
//
// **Tier0 只有两段**——身份 / 品牌语气。两段都走 `createCorePromptSegment`：
// 不读 facts、不带谓词，渲染结果在构造期即固定，稳定前缀因此在同一会话内逐字不变。
// 任何「按开关或按本轮输入注入」的内容（能力协议、当前时间、用户附加提示词）一律 Tier1，落活动尾。
import { isTrue } from '@velaros-ai/core'

import { type AppRuntimeFacts, readAppRuntimeFacts } from '../agent/AppRuntimeFacts'

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

const RuntimePlatformLabels: Readonly<Record<string, string | undefined>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
}

function formatRuntimeFact(value: string | null | undefined): Nullable<string> {
  const normalized = value?.trim().replace(/[\r\n]+/gu, ' ')
  return normalized || null
}

/** 把宿主已配置的进程级事实渲染成模型首条命令前即可读取的环境说明。 */
function formatRuntimeEnvironment(facts: AppRuntimeFacts): Nullable<string> {
  const platform = formatRuntimeFact(facts.platform)
  const platformLabel = platform ? RuntimePlatformLabels[platform] : null
  const rows: Array<[string, Nullable<string>]> = [
    ['宿主应用版本', formatRuntimeFact(facts.appVersion)],
    ['操作系统', platform ? `${platformLabel ? `${platformLabel} / ` : ''}${platform}` : null],
    ['CPU 架构', formatRuntimeFact(facts.arch)],
    ['系统版本', formatRuntimeFact(facts.osRelease)],
    ['命令 Shell', formatRuntimeFact(facts.shell)],
    ['用户主目录', formatRuntimeFact(facts.homeDir)],
    ['应用数据目录', formatRuntimeFact(facts.userDataRoot)],
    ['Velar Hooks HTTP 端点', formatRuntimeFact(facts.velarHookHttpUrl)],
    ['Velar Hooks 描述文件', formatRuntimeFact(facts.velarHookEndpointFilePath)],
  ]
  const availableRows = rows.filter((row): row is [string, string] => !!row[1])
  if (availableRows.length === 0) return null

  return [
    '当前运行环境：',
    ...availableRows.map(([label, value]) => `- ${label}：${value}`),
    '生成命令时以这里声明的操作系统与 Shell 为准；只有需要更细的实时状态或工具可用性时才检查环境。',
  ].join('\n')
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
    {
      id: 'runtime.environment',
      label: 'Current Runtime Environment',
      tier: 'runtime',
      source: 'runtime',
      retention: 'protected',
      priority: PromptSegmentPriority.runtime,
      render: () => formatRuntimeEnvironment(readAppRuntimeFacts()),
    },
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
          'Widget 是宿主内置的呈现方式，不属于用户本轮选择的能力。',
          '默认使用 Markdown；普通说明、简短回答和不需要专门视觉承载的内容都保持 Markdown。',
          '需要复杂说明展示、复杂图表、数据驱动状态、多状态或多步骤交互、Canvas/WebGL，或需要用户探索并进一步讲解时，才使用 Widget，并先读取 skill:widget-visual-output。',
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
          'HTML Live Preview 是宿主内置的呈现方式，不属于用户本轮选择的能力。',
          '当简单 HTML 页面、卡片、落地页、静态内容、轻交互或即时视觉效果比 Markdown 更直观时，使用 HTML Live Preview，并先读取 skill:html-artifact-output。',
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
          '呈现方式默认使用 Markdown；普通说明无需改成可视化内容。',
          '简单、直观的 HTML 实时效果和轻交互使用 HTML Live Preview；复杂说明展示、复杂图表、数据驱动界面、多状态或多步骤交互使用 Widget。',
          '用户需要交互、演示或进一步讲解时，按内容复杂度在两者中选择最合适的一种；只有任务确实包含两种用途不同的呈现时才同时使用。',
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
