import { isBlank,isEmpty } from '@velaros-ai/core'

import type { KnowledgeSearchResult } from './knowledge/domain/Types'
class KnowledgeContext {
  public buildKnowledgeRecallContext(results: KnowledgeSearchResult[]): Nullable<string> {
    if (isEmpty(results)) return null

    const sections = results
      .slice(0, 4)
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
      .slice(0, 4)
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

export { KnowledgeContext }
export { KnowledgeContext as AgentKnowledgeHelper }
