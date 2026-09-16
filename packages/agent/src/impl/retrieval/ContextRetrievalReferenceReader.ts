import type { ArtifactManifestSnippet, LogReadSnippet, ReferencedArtifactPath, ReferencedLogPath } from '../../types/retrieval.js'
import {
  formatArtifactManifests,
  formatLogSnippets,
  readReferencedArtifactManifestSnippets,
  readReferencedLogSnippets,
} from '../../utils/retrieval/reference-reader'

import { contextRetrievalReferences } from './ContextRetrievalReferences'

/**
 * 将 {@link contextRetrievalReferences} 扫描到的磁盘路径**读入内存** `snippet`。
 *
 * ## 调用方
 * - {@link ContextRetrievalPayloadReader.retrieveToolPayload}：展开工具结果时附带日志/`artifact` 正文
 * - {@link ChatContextRetrievalService.searchTerminalOutput}：对每条 `logReference` 读盘后打分
 *
 * ## 安全与降级
 * - 再次校验 `isInternalCommandLogPath` / `isInternalArtifactPath`，拒绝外部路径
 * - 文件不存在、非普通文件、二进制（含 `NUL` 字节）、打开失败 → `content`/`preview=null` + 告警
 * - 大日志不整文件读入：`head+tail` 采样
 *
 * 读盘与格式化本身是纯函数（`utils/retrieval/reference-reader.ts`），这里只钉住两个采样参数并把
 * 条数上限接到 {@link contextRetrievalReferences}；每 {@link ChatContextRetrievalService} 实例
 * 持有一个 `Reader`（无全局单例）。
 */
export interface ContextRetrievalReferenceReaderApi {
  /**
   * 批量读取日志引用，把 `totalBudgetChars` 均分给每条（每条至少 800 字符），最多读
   * `maxReferencedLogs` 条。空输入返回 `[]`；单条读不动时该条带 `warning` 返回，不抛错。
   */
  readReferencedLogs(
    references: ReferencedLogPath[],
    totalBudgetChars: number,
  ): Promise<LogReadSnippet[]>
  /**
   * 批量读取 artifact manifest（metadata + 可选 preview），最多读 `maxReferencedArtifacts` 条。
   * 非文本扩展名只报 filename/type/size 不读正文；读不动时该条带 `warning` 返回，不抛错。
   */
  readReferencedArtifactManifests(
    references: ReferencedArtifactPath[],
  ): Promise<ArtifactManifestSnippet[]>
  /** 把日志 snippet 列表格式化成 agent 可读的多段文本（`---` 分隔），拼进 `content.referencedLogs`。 */
  formatLogSnippets(snippets: LogReadSnippet[]): string
  /** 把 artifact manifest 列表格式化成多段文本（`---` 分隔），拼进 `content.referencedArtifacts`。 */
  formatArtifactManifests(snippets: ArtifactManifestSnippet[]): string
}

class ContextRetrievalReferenceReader implements ContextRetrievalReferenceReaderApi {
  /** 单个文本 artifact preview 的最大字符数（读盘时按 ×4 估算字节上限）。 */
  private readonly artifactPreviewChars = 1_500;
  /** 大日志 head+tail 采样时，head 占 maxBytes 的比例（余下给 tail）。 */
  private readonly logReadHeadRatio = 0.35;

  public async readReferencedLogs(
    references: ReferencedLogPath[],
    totalBudgetChars: number,
  ): Promise<LogReadSnippet[]> {
    return readReferencedLogSnippets(
      references,
      totalBudgetChars,
      contextRetrievalReferences.maxReferencedLogs,
      this.logReadHeadRatio,
    );
  }

  public async readReferencedArtifactManifests(
    references: ReferencedArtifactPath[],
  ): Promise<ArtifactManifestSnippet[]> {
    return readReferencedArtifactManifestSnippets(
      references,
      contextRetrievalReferences.maxReferencedArtifacts,
      this.artifactPreviewChars,
    );
  }

  public formatLogSnippets(snippets: LogReadSnippet[]): string {
    return formatLogSnippets(snippets);
  }

  public formatArtifactManifests(snippets: ArtifactManifestSnippet[]): string {
    return formatArtifactManifests(snippets);
  }
}

export { ContextRetrievalReferenceReader };
