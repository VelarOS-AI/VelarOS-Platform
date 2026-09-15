import { toNullable } from '@velaros-ai/core'
export interface ContextPayloadRecord {
  sessionId: string
  hash: string
  payloadRef: string
  toolCallId: string
  toolName: string
  serializedResult: string
  chars: number
  createdAt: number
}

export interface ContextUserTextRecord {
  sessionId: string
  hash: string
  payloadRef: string
  messageKey: string
  text: string
  chars: number
  createdAt: number
}

export interface ContextPayloadStore {
  findByHash(sessionId: string, hash: string): Promise<Nullable<ContextPayloadRecord>>
  findManyByHash?(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextPayloadRecord>>
  put(record: ContextPayloadRecord): Promise<ContextPayloadRecord>
  putMany?(records: readonly ContextPayloadRecord[]): Promise<ContextPayloadRecord[]>
  listForSession(sessionId: string): Promise<ContextPayloadRecord[]>
  findUserTextByHash?(
    sessionId: string,
    hash: string
  ): Promise<Nullable<ContextUserTextRecord>>
  findUserTextsByHash?(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextUserTextRecord>>
  putUserText?(record: ContextUserTextRecord): Promise<ContextUserTextRecord>
  putUserTextMany?(records: readonly ContextUserTextRecord[]): Promise<ContextUserTextRecord[]>
}

function createStoreKey(sessionId: string, hash: string): string {
  return `${sessionId}:${hash}`
}

export function createContextPayloadRef(sessionId: string, hash: string): string {
  return `ctx-payload:${encodeURIComponent(sessionId)}:${hash}`
}

export function createContextUserTextRef(sessionId: string, hash: string): string {
  return `ctx-user-payload:${encodeURIComponent(sessionId)}:${hash}`
}

const ContextUserTextToolName = '__context_user_text__'

export class InMemoryContextPayloadStore implements ContextPayloadStore {
  private readonly recordsByKey = new Map<string, ContextPayloadRecord>()
  private readonly userTextByKey = new Map<string, ContextUserTextRecord>()

  public async findByHash(
    sessionId: string,
    hash: string
  ): Promise<Nullable<ContextPayloadRecord>> {
    return toNullable(this.recordsByKey.get(createStoreKey(sessionId, hash)))
  }

  public async findManyByHash(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextPayloadRecord>> {
    const records = new Map<string, ContextPayloadRecord>()

    for (const hash of new Set(hashes)) {
      const record = await this.findByHash(sessionId, hash)
      if (record) records.set(hash, record)
    }

    return records
  }

  public async put(record: ContextPayloadRecord): Promise<ContextPayloadRecord> {
    const key = createStoreKey(record.sessionId, record.hash)
    const existing = this.recordsByKey.get(key)

    if (existing) return existing

    this.recordsByKey.set(key, record)
    return record
  }

  public async putMany(records: readonly ContextPayloadRecord[]): Promise<ContextPayloadRecord[]> {
    const stored: ContextPayloadRecord[] = []

    for (const record of records) {
      stored.push(await this.put(record))
    }

    return stored
  }

  public async listForSession(sessionId: string): Promise<ContextPayloadRecord[]> {
    return Array.from(this.recordsByKey.values()).filter(
      (record) => record.sessionId === sessionId,
    )
  }

  public async findUserTextByHash(
    sessionId: string,
    hash: string
  ): Promise<Nullable<ContextUserTextRecord>> {
    return toNullable(this.userTextByKey.get(createStoreKey(sessionId, hash)))
  }

  public async putUserText(record: ContextUserTextRecord): Promise<ContextUserTextRecord> {
    const key = createStoreKey(record.sessionId, record.hash)
    const existing = this.userTextByKey.get(key)
    if (existing) return existing

    this.userTextByKey.set(key, record)
    await this.put({
      sessionId: record.sessionId,
      hash: record.hash,
      payloadRef: record.payloadRef,
      toolCallId: record.messageKey,
      toolName: ContextUserTextToolName,
      serializedResult: record.text,
      chars: record.chars,
      createdAt: record.createdAt,
    })
    return record
  }

  public async findUserTextsByHash(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextUserTextRecord>> {
    const records = new Map<string, ContextUserTextRecord>()
    for (const hash of new Set(hashes)) {
      const record = await this.findUserTextByHash(sessionId, hash)
      if (record) records.set(hash, record)
    }
    return records
  }

  public async putUserTextMany(
    records: readonly ContextUserTextRecord[]
  ): Promise<ContextUserTextRecord[]> {
    const stored: ContextUserTextRecord[] = []
    for (const record of records) {
      stored.push(await this.putUserText(record))
    }
    return stored
  }
}
