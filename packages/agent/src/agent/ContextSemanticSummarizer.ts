/**
 * 语义级历史摘要器（多级压缩的第二级）。
 *
 * 规则式压缩（compaction.ts）靠关键词/预览抽取，足够快且零成本，是第一级回收；
 * 但它对“极隐式的决策、跨轮因果”可能漏抓。本模块提供第二级：用一次轻量模型调用，
 * 把较老历史压成更准确的结构化语义摘要。
 *
 * 成本纪律：这一级**只在规则压缩仍压不到目标、或缺页降级到该档时**才触发，
 * 不是每轮都调；且喂给摘要模型的输入本身做了字节上限截断，避免“为压缩反而又超限”。
 *
 * 解耦：本模块只依赖统一模型请求层与一个已解析好的 LanguageModel，
 * 不感知 provider 解析 / 角色 / 工具，由调用方（SoloLoop/QueryLoop）用其已解析的
 * provider 现场构造 LanguageModel 后注入。
 */

import type { LanguageModel, ModelMessage } from 'ai'

import { isBlank, isEmpty, isObject, isPresent, isString, toNullable,toOptional, trimmedStringOrEmpty, truncate } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  type AgentModelRequestOptions,
  type AgentModelRequestPort,
  AiSdkAgentModelRequestPort,
} from './model'

const log = logRuntime.tag('ContextSemanticSummarizer')
const defaultModelRequestService = new AiSdkAgentModelRequestPort()

/** 喂给摘要模型的历史输入字节上限，避免摘要请求本身过大。 */
const MaxSummarizerInputChars = 48_000
/** 单条消息序列化预览上限。 */
const MaxPerMessageChars = 2_400

interface SemanticSummaryRequest {
  model: LanguageModel
  /** 待折叠的较老历史消息。 */
  olderMessages: ModelMessage[]
  /** 规则式压缩产出的结构化摘要，作为种子/兜底。 */
  ruleSummary: Nullable<string>
  /** 压缩前运行时或 hook 追加的本次摘要指导。 */
  summaryGuidance?: readonly string[]
  /** 期望摘要正文字符上限（用于约束输出长度）。 */
  targetChars: number
  signal?: LooseOptional<AbortSignal>
  modelRequestOptions?: AgentModelRequestOptions
  modelRequestService?: AgentModelRequestPort
}

interface SemanticSummaryResult {
  summary: string
  title: Nullable<string>
}

const SummarizerSystemPrompt = [
  '你是上下文压缩器。把下面“较早的对话历史”压成简洁、忠实的结构化摘要，',
  '供后续轮次作为被移除历史的权威上下文，同时生成一个简短会话标题。',
  '只输出 JSON，不要输出 Markdown 代码块。JSON 结构：{"title":"简短标题","summary":"结构化摘要正文"}。',
  'summary 严格按以下分区输出（无内容的分区可省略）：',
  '目标 / 关键决策 / 涉及文件或模块 / 待解决问题 / 验证状态 / 进展。',
  'title 不要超过 18 个汉字或 40 个英文字符；不得为空；不得包含换行。',
  '只保留对“继续当前任务”有用的事实锚点；不要复述寒暄、不要臆造、不要给出新的执行建议。',
  '已有规则摘要中的文件路径、文件名、验证命令和构建/测试命令必须逐字保留；不确定时保留原短语。',
  '务必精炼。',
].join('\n')

function serializeMessageForSummary(message: ModelMessage): string {
  const { role } = message
  const content = message.content
  let text: string
  if (isString(content)) {
    text = content
  } else {
    try {
      text = JSON.stringify(content)
    } catch {
      // arch-guard:silent-catch-ok 序列化兜底：content 含循环引用时回落 String()，本就是降级路径无需上报
      text = String(content)
    }
  }

  return `[${role}] ${truncate(text, MaxPerMessageChars)}`
}

function normalizeSummaryGuidance(summaryGuidance?: readonly string[]): string[] {
  return (summaryGuidance ?? [])
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => !isBlank(item))
    .map((item) => truncate(item, 500))
}

/** 把较老消息序列化为有界文本（从最近的较老消息往前取，直到字节预算用尽）。 */
function buildSummarizerInput(
  olderMessages: ModelMessage[],
  ruleSummary: Nullable<string>,
  summaryGuidance?: readonly string[]
): string {
  const blocks: string[] = []
  let used = 0
  // 从尾部（更接近当前）往前收集，优先保留更相关的较老内容。
  for (let index = olderMessages.length - 1; index >= 0; index -= 1) {
    const block = serializeMessageForSummary(olderMessages[index])
    if (used + block.length > MaxSummarizerInputChars && !isEmpty(blocks)) {
      break
    }
    blocks.unshift(block)
    used += block.length
  }

  const sections: string[] = []
  if (isPresent(ruleSummary) && !isBlank(ruleSummary)) {
    sections.push(`已有规则摘要（作为种子，可纠正/补全）：\n${ruleSummary}`)
  }
  const guidance = normalizeSummaryGuidance(summaryGuidance)
  if (!isEmpty(guidance)) {
    sections.push(`额外摘要指导（必须遵守）：\n${guidance.map((item) => `- ${item}`).join('\n')}`)
  }
  sections.push(`较早的对话历史：\n${blocks.join('\n')}`)
  return sections.join('\n\n')
}

function normalizeSummaryTitle(value: unknown): Nullable<string> {
  if (!isString(value)) return null

  const normalized = value.replace(/\s+/g, ' ').trim()
  return isBlank(normalized) ? null : truncate(normalized, 40)
}

function extractJsonObjectText(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenceMatch?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) return candidate.slice(start, end + 1)

  return candidate
}

function parseSemanticSummaryResult(text: string): Nullable<SemanticSummaryResult> {
  const trimmed = text.trim()
  if (isBlank(trimmed)) return null

  try {
    const parsed = JSON.parse(extractJsonObjectText(trimmed)) as unknown
    if (isObject(parsed)) {
      const record = parsed as Record<string, unknown>
      const summary = trimmedStringOrEmpty(record.summary)
      if (!isBlank(summary))
        return {
          summary,
          title: normalizeSummaryTitle(record.title),
        }
    }
  } catch {
    // arch-guard:silent-catch-ok 摘要模型可能没有严格返回 JSON；保留旧的纯文本摘要兼容路径。
  }

  return {
    summary: trimmed,
    title: null,
  }
}

/**
 * 生成语义摘要正文和标题（不含 marker/说明前缀，由调用方包裹）。
 * 失败、被中断或产出为空时返回 null，调用方回落规则摘要。
 */
async function summarizeOlderHistoryWithTitle(
  request: SemanticSummaryRequest
): Promise<Nullable<SemanticSummaryResult>> {
  if (isEmpty(request.olderMessages)) return null

  try {
    const text = await (
      request.modelRequestService ?? defaultModelRequestService
    ).summarizeContextSemantics({
      model: request.model,
      system: SummarizerSystemPrompt,
      prompt: buildSummarizerInput(
        request.olderMessages,
        request.ruleSummary,
        request.summaryGuidance
      ),
      abortSignal: toOptional(request.signal),
      maxOutputTokens: Math.max(256, Math.ceil(request.targetChars / 3)),
      modelRequestOptions: request.modelRequestOptions,
    })
    const parsed = parseSemanticSummaryResult(text)
    if (!parsed || isBlank(parsed.summary)) return null

    return {
      summary: truncate(parsed.summary, Math.max(256, request.targetChars)),
      title: parsed.title,
    }
  } catch (error) {
    log.warn('语义摘要调用失败，回落规则摘要', { error: AppError.getMessage(error) })
    return null
  }
}

/**
 * 生成语义摘要正文（不含 marker/说明前缀，由调用方包裹）。
 * 保留字符串返回契约，供现有 Solo/Query 压缩循环继续复用。
 */
async function summarizeOlderHistory(request: SemanticSummaryRequest): Promise<Nullable<string>> {
  const result = await summarizeOlderHistoryWithTitle(request)
  return toNullable(result?.summary)
}

/** 解析候选摘要模型运行时（与 SoloLoop/QueryLoop 的角色运行时同构的最小子集）。 */
interface SummarizerCandidateRuntime {
  provider: (modelId: string, options?: AgentModelRequestOptions) => LanguageModel
  model: string
  modelRequestOptions?: AgentModelRequestOptions
  resolutionSource: string
}

interface ResolveSummarizerModelInput {
  mainModel: () => LanguageModel
  resolveCandidate?: () => Promise<LooseOptional<SummarizerCandidateRuntime>>
}

/**
 * 解析语义摘要应使用的 LanguageModel：默认复用主模型；设置页指定了可用的摘要服务商+模型
 * 时改用之；缺密钥 / 解析回退到服务商池 / 解析异常时一律自动 fallback 回主模型。
 *
 * 抽到共享函数是因为 SoloLoop 与 QueryLoop 的这段 fallback 决策逻辑完全一致，
 * 只有底层 resolveRoleRuntime 的入参形态不同（由 resolveConfigured 回调消化差异）。
 */
async function resolveSummarizerLanguageModel(
  input: ResolveSummarizerModelInput
): Promise<LanguageModel> {
  if (!input.resolveCandidate) return input.mainModel()
  try {
    const candidate = await input.resolveCandidate()
    if (!candidate) return input.mainModel()
    return candidate.provider(candidate.model, candidate.modelRequestOptions)
  } catch {
    return input.mainModel()
  }
}

export {
  MaxSummarizerInputChars,
  resolveSummarizerLanguageModel,
  summarizeOlderHistory,
  summarizeOlderHistoryWithTitle,
}
export type { SemanticSummaryRequest, SemanticSummaryResult, SummarizerCandidateRuntime }
