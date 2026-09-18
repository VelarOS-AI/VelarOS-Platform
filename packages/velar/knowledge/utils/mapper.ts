/**
 * 端口交回的形状到模型面的边界映射：只带声明里有的字段，知识库引擎给得再多也不往外带。
 */

import type { KnowledgeHealth, KnowledgeHit, KnowledgeIndexDiagnostics, KnowledgeSearchRecord } from '../types/knowledge.js'

/** 一份命中文档的模型面形状；索引错误只在真有的时候出现。 */
export function projectHit(record: KnowledgeSearchRecord): KnowledgeHit {
  const hit: KnowledgeHit = {
    id: record.id,
    path: record.path,
    title: record.title,
    summary: record.summary,
    snippet: record.snippet,
    content: record.content,
    sourceKind: record.sourceKind,
    tags: [...record.tags],
    score: record.score,
    matchType: record.matchType,
    indexStatus: record.indexStatus,
    updatedAt: record.updatedAt,
  }
  const indexError = record.indexError.trim()
  if (indexError) hit.indexError = indexError
  return hit
}

/** 索引诊断的模型面形状：计数原样，文件索引、向量库与嵌入运行时各取模型用得上的那一项。 */
export function projectHealth(diagnostics: KnowledgeIndexDiagnostics): KnowledgeHealth {
  return {
    totalDocuments: diagnostics.totalDocuments,
    readyDocuments: diagnostics.readyDocuments,
    pendingDocuments: diagnostics.pendingDocuments,
    partialDocuments: diagnostics.partialDocuments,
    failedDocuments: diagnostics.failedDocuments,
    outdatedDocuments: diagnostics.outdatedDocuments,
    activeProfileIndexedDocuments: diagnostics.activeProfileIndexedDocuments,
    activeProfileMissingDocuments: diagnostics.activeProfileMissingDocuments,
    totalChunks: diagnostics.totalChunks,
    trackedFiles: diagnostics.fileIndex.trackedFiles,
    vectorRows: diagnostics.vectorStore.rowCount,
    embedding: { provider: diagnostics.runtime.provider, model: diagnostics.runtime.model },
    workspaces: diagnostics.workspaceSyncs.map((sync) => ({ workspaceRoot: sync.workspaceRoot, lastSyncedAt: sync.lastSyncedAt })),
  }
}
