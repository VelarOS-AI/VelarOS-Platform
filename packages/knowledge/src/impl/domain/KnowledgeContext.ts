import { isBlank, isEmpty } from '@velaros-ai/core'

import type { KnowledgeSearchResult } from '../../types/knowledge.js'
import { KnowledgeTuning } from '../../utils/tuning.js'

/**
 * 召回文本拼装器：把检索结果拼成一段可以直接放进提示词的上下文。
 *
 * 文档类与代码类分成两句不同的说明，都写明「和当前源码冲突时以源码为准」。
 * 无状态，实例可以随取随用。
 */
export interface KnowledgeContextApi {
  /** 把文档类召回拼成一段项目知识上下文；没有结果返回 null。 */
  buildKnowledgeRecallContext(results: KnowledgeSearchResult[]): Nullable<string>
  /** 把代码类召回拼成一段代码候选上下文；没有结果返回 null。 */
  buildCodeRecallContext(results: KnowledgeSearchResult[]): Nullable<string>
}

/** 见 {@link KnowledgeContextApi}。 */
export class KnowledgeContext implements KnowledgeContextApi {
  public buildKnowledgeRecallContext(results: KnowledgeSearchResult[]): Nullable<string> {
    if (isEmpty(results)) return null

    const sections = results
      .slice(0, KnowledgeTuning.query.recallSections)
      .map((result, index) => [
        `${index + 1}. ${result.title} (${result.path})`,
        isBlank(result.summary) ? null : `摘要：${result.summary}`,
        `片段：${result.snippet}`,
      ].filter((line): line is string => !!line).join('\n'))

    return [
      '为当前任务召回的项目知识片段：',
      '这些内容来自工作区文档和项目配置，可作为实现约束和术语背景；如果与当前源码冲突，以当前源码为准。',
      ...sections,
    ].join('\n\n')
  }

  public buildCodeRecallContext(results: KnowledgeSearchResult[]): Nullable<string> {
    if (isEmpty(results)) return null

    const sections = results
      .slice(0, KnowledgeTuning.query.recallSections)
      .map((result, index) => [
        `${index + 1}. ${result.path}`,
        isBlank(result.summary) ? null : `索引摘要：${result.summary}`,
        `相关代码片段：${result.snippet}`,
      ].filter((line): line is string => !!line).join('\n'))

    return [
      '为当前任务召回的代码候选片段：',
      '这些片段来自当前任务相关的源码文件索引，可用于更快定位实现入口；在真正修改前，仍然要回到工作区读取原文件确认。',
      ...sections,
    ].join('\n\n')
  }
}
