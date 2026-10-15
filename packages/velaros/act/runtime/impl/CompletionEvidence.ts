import { isEmpty, isNull, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CompletionEvidenceDependencies } from '../contract/requires.js'
import type {
  CompletionEvidenceBatch,
  CompletionEvidenceDescriptor,
  CompletionEvidenceInput,
  CompletionEvidencePage,
} from '../types/completion-evidence.js'
import { completionEvidenceInput, completionEvidencePage } from '../utils/completion-evidence.js'
import {
  completionHash,
  completionMaterialHash,
  completionSnapshotMatches,
} from '../utils/completion-review.js'
import { awaitModelPreparation } from '../utils/model-budget.js'
import { CompletionReviewLimits } from '../utils/tuning.js'

/** 目录用于发现；正文只由 retrieve 返回，调用者仅将实际发给模型的片段登记为可引用材料。 */
export interface CompletionEvidenceApi {
  /** 可读取的文件与执行记录身份，摘要不等于已展示原文。 */
  readonly catalog: readonly CompletionEvidenceDescriptor[]
  /** 按固定身份批量查找或读取，每次重新核对依赖代次与剩余预算。 */
  retrieve(input: CompletionEvidenceInput, signal: AbortSignal): Promise<CompletionEvidenceBatch>
}

/** 单次完成复核的只读证据与资源预算；每批重新核对授权及完整依赖代次。 */
export class CompletionEvidence implements CompletionEvidenceApi {
  public readonly catalog: readonly CompletionEvidenceDescriptor[]
  private queries = 0
  private bytes = 0
  private readonly cache = new Map<string, string>()
  private cacheBytes = 0

  public constructor(private readonly dependencies: CompletionEvidenceDependencies) {
    this.catalog = [
      {
        identity: 'execution:task',
        kind: 'execution',
        description:
          '本次目录中全部实际源码/回执对的只读索引正文；可先 find 命令或输出字面文本，再按对应 execution: 身份读取完整对。目录省略数另见 executionEvidence.catalogOmitted。',
      },
      ...dependencies.snapshot.materials
        .filter((material) => material.identity.startsWith('file:'))
        .map((material) => ({
          identity: material.identity,
          kind: 'artifact' as const,
          sha256: completionMaterialHash(material),
          bytes: material.metadata?.bytes ?? Buffer.byteLength(material.text),
        })),
      ...dependencies.executions.map((entry) => ({
        identity: entry.identity,
        kind: 'execution' as const,
        records: entry.records.map(({ title, createdAt, chars }) => ({ title, createdAt, chars })),
      })),
    ]
  }

  public async retrieve(
    input: CompletionEvidenceInput,
    signal: AbortSignal
  ): Promise<CompletionEvidenceBatch> {
    const { queries } = completionEvidenceInput(input)
    signal.throwIfAborted()
    if (this.queries + queries.length > CompletionReviewLimits.evidenceQueries)
      throw new AppError('LIMIT', '本次复核的证据查询次数已耗尽')
    this.queries += queries.length
    await this.dependencies.assertCurrent(signal)
    const pages: CompletionEvidencePage[] = []
    let remaining = Math.min(
      CompletionReviewLimits.evidenceBatchBytes,
      CompletionReviewLimits.evidenceBytes - this.bytes
    )
    const before = remaining
    for (const query of queries) {
      signal.throwIfAborted()
      try {
        if (!this.catalog.some((entry) => entry.identity === query.identity))
          throw new AppError('PERMISSION', '查询身份不在本次授权证据目录中')
        if (remaining <= 0) throw new AppError('LIMIT', '本次取证正文额度已耗尽')
        const text = await this.text(query.identity, signal)
        const page = completionEvidencePage(text, completionHash(text), query, remaining)
        remaining -= page.fragments.reduce(
          (sum, fragment) => sum + Buffer.byteLength(fragment.text),
          0
        )
        pages.push(page)
      } catch (error) {
        signal.throwIfAborted()
        if (
          !(error instanceof AppError) ||
          !['LIMIT', 'NOT_FOUND', 'UNAVAILABLE', 'PERMISSION'].includes(error.code)
        )
          throw error
        pages.push({
          query,
          fragments: [],
          nextOffset: null,
          issue: `${error.code}: ${AppError.getMessage(error)}`,
        })
      }
    }
    // 即便正文来自缓存，也不能在权限或目录绑定变化后继续发出旧证据。
    await this.dependencies.assertCurrent(signal)
    const bytes = before - remaining
    this.bytes += bytes
    return {
      pages,
      bytes,
      remainingQueries: CompletionReviewLimits.evidenceQueries - this.queries,
      remainingBytes: CompletionReviewLimits.evidenceBytes - this.bytes,
    }
  }

  private async text(identity: string, signal: AbortSignal): Promise<string> {
    const cached = this.cache.get(identity)
    if (!isUndefined(cached)) return cached
    const material = this.dependencies.snapshot.materials.find(
      (entry) => entry.identity === identity
    )
    let text: string
    if (material) {
      if (isUndefined(material.metadata)) return material.text
      if (!this.dependencies.artifacts.read)
        throw new AppError('UNAVAILABLE', '宿主未提供当前快照的按需正文读取')
      const read = await awaitModelPreparation(
        this.dependencies.artifacts.read(
          identity,
          this.dependencies.snapshot.fingerprint,
          CompletionReviewLimits.sourceBytes,
          signal
        ),
        signal
      )
      if (!completionSnapshotMatches(this.dependencies.snapshot.fingerprint, read.fingerprint))
        throw new AppError('STALE', '按需读取期间产物、目录绑定或授权发生变化')
      const body = read.materials.find((entry) => entry.identity === identity)
      if (!isEmpty(read.issues) || !body || !isUndefined(body.metadata))
        throw new AppError('UNAVAILABLE', read.issues.join('; ') || '宿主没有提供完整可读原文')
      text = body.text
      if (
        completionHash(text) !== completionMaterialHash(material) ||
        Buffer.byteLength(text) !== material.metadata.bytes
      )
        throw new AppError('PROTOCOL', '按需正文与完整文件哈希不一致')
    } else if (identity === 'execution:task') {
      if (
        this.dependencies.executions.reduce(
          (sum, entry) => sum + entry.records.reduce((count, record) => count + record.chars, 0),
          0
        ) > CompletionReviewLimits.sourceBytes
      )
        throw new AppError('LIMIT', '全部执行原文超过单次查找上限，请按目录分批读取具体执行身份')
      const entries: Array<{ identity: string; text: string }> = []
      let bytes = 0
      for (const entry of this.dependencies.executions) {
        const body = await this.text(entry.identity, signal)
        bytes += Buffer.byteLength(body)
        if (bytes > CompletionReviewLimits.sourceBytes)
          throw new AppError('LIMIT', '全部执行原文字节超过单次查找上限，请按目录分批读取')
        entries.push({ identity: entry.identity, text: body })
      }
      text = JSON.stringify({ entries })
    } else {
      const entry = this.dependencies.executions.find((item) => item.identity === identity)
      if (!entry) throw new AppError('PERMISSION', '执行记录不属于当前根任务')
      if (
        entry.records.reduce((sum, record) => sum + record.chars, 0) >
        CompletionReviewLimits.sourceBytes
      )
        throw new AppError('LIMIT', '完整执行源码/回执对超过单份原文读取上限')
      const records = []
      for (const record of entry.records) {
        const body = await awaitModelPreparation(
          this.dependencies.storage.get(record.ref.sessionId, record.objectId),
          signal
        )
        if (isNull(body)) throw new AppError('NOT_FOUND', '不可变执行原文缺失')
        records.push({ ref: record.ref, title: record.title, text: body })
      }
      text = JSON.stringify({ records })
    }
    const bytes = Buffer.byteLength(text)
    if (bytes > CompletionReviewLimits.sourceBytes)
      throw new AppError('LIMIT', '完整原文超过按需读取上限')
    while (
      this.cacheBytes + bytes > CompletionReviewLimits.sourceCacheBytes &&
      this.cache.size > 0
    ) {
      const first = this.cache.entries().next().value!
      this.cacheBytes -= Buffer.byteLength(first[1])
      this.cache.delete(first[0])
    }
    this.cache.set(identity, text)
    this.cacheBytes += bytes
    return text
  }
}
