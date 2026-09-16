import { createHash } from 'node:crypto'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { CanonicalizeToolResultInput, CanonicalToolResult, ContextPayloadRecord, HashedToolResultInput } from '../../types/context.js'
import { isStatefulToolResultName } from '../../utils/context/stateful-tool-results'
import { buildCanonicalToolResult } from '../../utils/context/tool-result-canonical'

import { createContextPayloadRef } from './InMemoryContextPayloadStore'

/** 构造参数：只有一项，决定多长的正文才改用地址而不是内联。 */
export interface ToolResultCanonicalizerOptions {
  /**
   * 内联预算，单位是序列化后的字符数：正文不超过它判 `inline`，超了判 `reference`。
   * 不传时用 8_000；取负数或小数会被夹成非负整数。注意它只影响判定标签，**不影响是否归档**——
   * 原文无论长短都存，去重也照做。
   */
  inlineBudgetChars?: number
}

/**
 * 工具结果归一化器：把工具结果原文按内容身份存进 `ContextPayloadStore`，并判定这次该内联还是给地址。
 *
 * 由 `ContextPayloadKernelToolOutputStore` 与 `ToolPayloadReferencePlanner` 各持一份（构造时收下 store）；
 * 自身无状态，去重完全靠 store 里已有的记录 + 本批次内的首现表。
 * 有状态的工具（`isStatefulToolResultName`）按 `toolCallId + 正文` 算哈希，避免两次不同调用的同文被当成同一条。
 */
export interface ToolResultCanonicalizerApi {
  /** 归一化单条结果；内部就是批量那条路走一次。批量返回不足一条属于不变量被破坏，直接抛错。 */
  canonicalize(input: CanonicalizeToolResultInput): Promise<CanonicalToolResult>
  /**
   * 批量归一化，返回值与入参**一一对应、顺序一致**。
   * 同会话同哈希在本批里只存一次，后来的那些判 `dedupe-reference` 并指回首次的 `toolCallId`；
   * store 里早就存过的同样判 dedupe。存完仍找不到某条的记录属于不变量被破坏，抛错而不是给个半成品。
   * 入参为空时返回空数组，不碰 store。
   */
  canonicalizeMany(inputs: readonly CanonicalizeToolResultInput[]): Promise<CanonicalToolResult[]>
}

const DefaultInlineBudgetChars = 8_000

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function createBatchKey(sessionId: string, hash: string): string {
  return `${sessionId}\u0000${hash}`
}

function hashToolResult(input: CanonicalizeToolResultInput): string {
  const content = isStatefulToolResultName(input.toolName)
    ? `${input.toolCallId}\u0000${input.serializedResult}`
    : input.serializedResult
  return sha256(content)
}

export class ToolResultCanonicalizer implements ToolResultCanonicalizerApi {
  private readonly inlineBudgetChars: number

  public constructor(
    private readonly store: ContextPayloadStore,
    options: ToolResultCanonicalizerOptions = {},
  ) {
    this.inlineBudgetChars = Math.max(0, Math.floor(options.inlineBudgetChars ?? DefaultInlineBudgetChars))
  }

  public async canonicalize(input: CanonicalizeToolResultInput): Promise<CanonicalToolResult> {
    const [result] = await this.canonicalizeMany([input])

    if (!result) throw new Error('ToolResultCanonicalizer.canonicalize 送进一条工具结果却没收回结果：批量归一化必须原样一进一出，少一条就意味着这次结果无法写进历史，因此中止。')

    return result
  }

  public async canonicalizeMany(
    inputs: readonly CanonicalizeToolResultInput[]
  ): Promise<CanonicalToolResult[]> {
    if (inputs.length === 0) return []

    const hashedInputs = inputs.map((input) => ({
      input,
      hash: hashToolResult(input),
    }))
    const firstInputByKey = new Map<string, HashedToolResultInput>()
    const hashesBySessionId = new Map<string, Set<string>>()

    for (const hashed of hashedInputs) {
      const key = createBatchKey(hashed.input.sessionId, hashed.hash)
      if (firstInputByKey.has(key)) continue

      firstInputByKey.set(key, hashed)

      const hashes = hashesBySessionId.get(hashed.input.sessionId) ?? new Set<string>()
      hashes.add(hashed.hash)
      hashesBySessionId.set(hashed.input.sessionId, hashes)
    }

    const recordsByKey = await this.findExistingRecords(hashesBySessionId)
    const existingKeys = new Set(recordsByKey.keys())
    const recordsToPut: ContextPayloadRecord[] = []

    for (const [key, hashed] of firstInputByKey) {
      if (recordsByKey.has(key)) continue

      recordsToPut.push({
        sessionId: hashed.input.sessionId,
        hash: hashed.hash,
        payloadRef: createContextPayloadRef(hashed.input.sessionId, hashed.hash),
        toolCallId: hashed.input.toolCallId,
        toolName: hashed.input.toolName,
        serializedResult: hashed.input.serializedResult,
        chars: hashed.input.serializedResult.length,
        createdAt: Date.now(),
      })
    }

    for (const record of await this.putRecords(recordsToPut)) {
      recordsByKey.set(createBatchKey(record.sessionId, record.hash), record)
    }

    return hashedInputs.map((hashed) => {
      const key = createBatchKey(hashed.input.sessionId, hashed.hash)
      const record = recordsByKey.get(key)
      if (!record) throw new Error(`hash ${hashed.hash} 在上下文 payload 存储里没有对应记录：刚写入的这批记录没能按原 hash 读回来，工具结果会失去可召回的正文，因此中止。`)

      const firstInput = firstInputByKey.get(key)?.input
      const isExisting = existingKeys.has(key)
      const isDuplicateInBatch = firstInput?.toolCallId !== hashed.input.toolCallId

      if (isExisting || isDuplicateInBatch)
        return buildCanonicalToolResult(hashed.input, record, 'dedupe-reference', record.toolCallId)

      const action =
        hashed.input.serializedResult.length > this.inlineBudgetChars ? 'reference' : 'inline'

      return buildCanonicalToolResult(hashed.input, record, action)
    })
  }

  private async findExistingRecords(
    hashesBySessionId: Map<string, Set<string>>
  ): Promise<Map<string, ContextPayloadRecord>> {
    const recordsByKey = new Map<string, ContextPayloadRecord>()

    for (const [sessionId, hashes] of hashesBySessionId) {
      const uniqueHashes = Array.from(hashes)

      if (this.store.findManyByHash) {
        const records = await this.store.findManyByHash(sessionId, uniqueHashes)

        for (const [hash, record] of records) {
          recordsByKey.set(createBatchKey(sessionId, hash), record)
        }

        continue
      }

      for (const hash of uniqueHashes) {
        const record = await this.store.findByHash(sessionId, hash)
        if (record) recordsByKey.set(createBatchKey(sessionId, hash), record)
      }
    }

    return recordsByKey
  }

  private async putRecords(
    records: readonly ContextPayloadRecord[]
  ): Promise<ContextPayloadRecord[]> {
    if (records.length === 0) return []

    if (this.store.putMany) return this.store.putMany(records)

    const stored: ContextPayloadRecord[] = []

    for (const record of records) {
      stored.push(await this.store.put(record))
    }

    return stored
  }
}
