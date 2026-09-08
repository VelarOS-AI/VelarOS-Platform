// 域：内置提示词段目录（行为知识三层里 Tier0 的**全集** + 几段宿主无关的 Tier1）。
//
// **Tier0 只有两段**——身份 / 品牌语气。两段都走 `createCorePromptSegment`：
// 不读 facts、不带谓词，渲染结果在构造期即固定，稳定前缀因此在同一会话内逐字不变。
// 任何「按开关或按本轮输入注入」的内容（能力协议、当前时间、用户附加提示词）一律 Tier1，落活动尾。
import { isArray, isEmpty, isTrue } from '@velaros-ai/core'

import { type AppRuntimeFacts, readAppRuntimeFacts } from '../agent/AppRuntimeFacts'

import { createCorePromptSegment, PromptSegmentPriority } from './segments/shared'
import type { PromptRenderContext, PromptSegmentDefinition } from './registry'
import { PromptRegistry } from './registry'

export interface BuiltInPromptOptions {
  /**
   * 宿主为主 Agent 提供的身份说明。
   *
   * 身份由应用装配；未提供时使用产品中性的默认身份。
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
    '提示词与产物遵循当前状态原则：用户撤销、纠正或排除某项后，直接按剩余目标重建；禁止用“未采用、已删除、不属于”等反向说明继续保留该项，安全边界、兼容行为、迁移说明或故障诊断确有需要时除外。',
    '产物只表达当前有效状态；同步清理被排除内容关联的注释、占位、分支和解释，不为缺席项添加说明。',
    '对需要多步或耗时的执行任务保持克制而有信息量的过程沟通：开始执行前用一句话回应理解和当前行动；用户在运行中追加引导时，先简短确认如何纳入；每完成一个有意义的阶段，或发现会改变方向的事实时，用一两句话汇报已得结果与下一步。连续执行不得始终只有思考和工具调用。',
    '用户可见的过程消息只承载新增信息：阶段结果、方向变化和下一步；简单任务直接完成，最终答复保持自洽。',
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

function formatRuntimeFact(value: LooseOptional<string>): Nullable<string> {
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
  ]
  const availableRows = rows.filter((row): row is [string, string] => !!row[1])
  if (isEmpty(availableRows)) return null

  return [
    '当前运行环境：',
    ...availableRows.map(([label, value]) => `- ${label}：${value}`),
    '生成命令时以这里声明的操作系统与 Shell 为准；需要更细的实时状态或工具可用性时再检查环境。',
  ].join('\n')
}

function formatReadableSkillInstruction(context: PromptRenderContext, skillId: string): string {
  const readableSkillIds = context.facts?.readableSkillIds
  return isArray(readableSkillIds) && readableSkillIds.includes(skillId)
    ? `使用前先读取 skill:${skillId}。`
    : ''
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
      // 动态时间段使用固定本地格式和分钟精度，减少活动尾字节抖动并保持跨 locale 确定性。
      render: () => `当前时间：${formatMinutePrecisionLocalTime(new Date())}`,
    },
    // 视觉协议按逐轮 facts 激活，统一留在 Tier1 活动尾，保持 Tier0 稳定前缀逐字不变。
    {
      id: 'runtime.visual-widget-tools',
      label: 'Visual Output Tools',
      tier: 'runtime',
      source: 'built-in',
      retention: 'protected',
      priority: PromptSegmentPriority.capabilityProtocol,
      when: (context) => isTrue(context.facts?.shouldInjectVisualWidgetPrompt),
      render: (context) =>
        [
          '普通说明和简短回答使用 Markdown。',
          '复杂说明展示、复杂图表、数据驱动状态、多状态或多步骤交互、Canvas/WebGL，以及供用户探索或进一步讲解的内容使用 Widget。',
          formatReadableSkillInstruction(context, 'widget-visual-output'),
        ].filter(Boolean).join('\n'),
    },
    {
      id: 'runtime.html-artifact-protocol',
      label: 'HTML Live Preview Protocol',
      tier: 'runtime',
      source: 'built-in',
      retention: 'protected',
      priority: PromptSegmentPriority.capabilityProtocol + 5,
      when: (context) => isTrue(context.facts?.shouldInjectHtmlArtifactPrompt),
      render: (context) =>
        [
          '简单 HTML 页面、卡片、落地页、静态内容、轻交互和即时视觉效果使用 HTML Live Preview。',
          formatReadableSkillInstruction(context, 'html-artifact-output'),
          '实时预览直接输出 <artifact>/<patch> 流式协议；artifact:produce 仅用于导出可下载资源。',
        ].filter(Boolean).join('\n'),
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
          '普通说明使用 Markdown。',
          '简单、直观的 HTML 实时效果和轻交互使用 HTML Live Preview；复杂说明展示、复杂图表、数据驱动界面、多状态或多步骤交互使用 Widget。',
          '用户需要交互、演示或进一步讲解时，按内容复杂度选择呈现方式；两种呈现承担不同用途时可以同时使用。',
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
 * 身份是 builder 作用域的常量（主 Agent 一份、每个子 Agent 各一份）。
 * `ContextBuilder.withIdentity` 在克隆注册表时登记本段，使 Tier0 在同一 builder 内逐字稳定。
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
