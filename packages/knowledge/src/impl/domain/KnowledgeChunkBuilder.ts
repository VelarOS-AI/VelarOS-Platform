import { isBlank } from '@velaros-ai/core'

import { KnowledgeIndexConfig } from '../../contract/constants.js'
import type { KnowledgeRecord } from '../../types/knowledge.js'
import type { KnowledgeChunk } from '../../types/storage.js'
import { buildCodeChunks, buildDocumentChunks } from '../../utils/chunks.js'

/**
 * 知识分块构建器：文档按标题与空行切段，代码优先按符号切段。
 *
 * 每个 chunk 都带路径、标题与来源类型前缀，向量检索命中时还能看出上下文。
 * 实例由知识库运行时持有，本身不带状态。
 */
export interface KnowledgeChunkBuilderApi {
  /** 当前的分块策略版本；文件快照只跟踪它，嵌入 profile 切换不算内容过期。 */
  getIndexRuntimeKey(): string
  /** 按来源类型选文档分块还是代码分块，过短的片段丢掉。 */
  build(knowledge: KnowledgeRecord): KnowledgeChunk[]
  /** 拼出参与 hash 的索引文本，内容或分块策略变了它就变。 */
  buildIndexSource(knowledge: KnowledgeRecord, chunks?: KnowledgeChunk[]): string
}

/** 见 {@link KnowledgeChunkBuilderApi}。 */
export class KnowledgeChunkBuilder implements KnowledgeChunkBuilderApi {
  /** 索引输入版本；分块策略变了就改它，旧文件会被判定为过期。 */
  private static readonly indexSourceVersion = 'knowledge-chunk-builder:v2'

  public getIndexRuntimeKey(): string {
    return KnowledgeChunkBuilder.indexSourceVersion
  }

  public build(knowledge: KnowledgeRecord): KnowledgeChunk[] {
    const rawChunks =
      knowledge.sourceKind === 'code'
        ? buildCodeChunks(knowledge)
        : buildDocumentChunks(knowledge)

    return rawChunks
      .filter((chunk) => chunk.length >= KnowledgeIndexConfig.MIN_CHUNK_LENGTH)
      .map((content, index) => ({ index, content }))
  }

  public buildIndexSource(
    knowledge: KnowledgeRecord,
    chunks: KnowledgeChunk[] = this.build(knowledge)
  ): string {
    const serializedChunks = chunks
      .map((chunk) => `# chunk ${chunk.index}\n${chunk.content}`)
      .join('\n\n---\n\n')

    return [
      KnowledgeChunkBuilder.indexSourceVersion,
      `knowledge:${knowledge.id}`,
      serializedChunks,
    ]
      .filter((part) => !isBlank(part))
      .join('\n\n')
  }
}
