import { createHash } from 'node:crypto'

import {
  type ContextPayloadRecord,
  type ContextPayloadStore,
  createContextPayloadRef,
} from './ContextPayloadStore'
import { isStatefulToolResultName } from './StatefulToolResults'

export interface CanonicalizeToolResultInput {
  sessionId: string
  toolCallId: string
  toolName: string
  serializedResult: string
}

export interface CanonicalToolResultVisibleReference {
  type: 'tool-payload-ref'
  toolCallId: string
  toolName: string
  payloadRef: string
  hash: string
  chars: number
  sameAsToolCallId?: string
}

export interface CanonicalToolResult {
  action: 'inline' | 'reference' | 'dedupe-reference'
  hash: string
  payloadRef: string
  record: ContextPayloadRecord
  visible: CanonicalToolResultVisibleReference
}

export interface ToolResultCanonicalizerOptions {
  inlineBudgetChars?: number
}

const DefaultInlineBudgetChars = 8_000

interface HashedToolResultInput {
  input: CanonicalizeToolResultInput
  hash: string
}

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

export class ToolResultCanonicalizer {
  private readonly inlineBudgetChars: number

  public constructor(
    private readonly store: ContextPayloadStore,
    options: ToolResultCanonicalizerOptions = {},
  ) {
    this.inlineBudgetChars = Math.max(0, Math.floor(options.inlineBudgetChars ?? DefaultInlineBudgetChars))
  }

  public async canonicalize(input: CanonicalizeToolResultInput): Promise<CanonicalToolResult> {
    const [result] = await this.canonicalizeMany([input])

    if (!result) throw new Error('ToolResultCanonicalizer.canonicalize expected one result')

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
      if (!record) throw new Error(`Missing context payload record for hash ${hashed.hash}`)

      const firstInput = firstInputByKey.get(key)?.input
      const isExisting = existingKeys.has(key)
      const isDuplicateInBatch = firstInput?.toolCallId !== hashed.input.toolCallId

      if (isExisting || isDuplicateInBatch)
        return this.toResult(hashed.input, record, 'dedupe-reference', record.toolCallId)

      const action =
        hashed.input.serializedResult.length > this.inlineBudgetChars ? 'reference' : 'inline'

      return this.toResult(hashed.input, record, action)
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

  private toResult(
    input: CanonicalizeToolResultInput,
    record: ContextPayloadRecord,
    action: CanonicalToolResult['action'],
    sameAsToolCallId?: string,
  ): CanonicalToolResult {
    return {
      action,
      hash: record.hash,
      payloadRef: record.payloadRef,
      record,
      visible: {
        type: 'tool-payload-ref',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        payloadRef: record.payloadRef,
        hash: record.hash,
        chars: record.chars,
        sameAsToolCallId,
      },
    }
  }
}
