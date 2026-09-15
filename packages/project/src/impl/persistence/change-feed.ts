import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isArray, isNumber, isObject, isString } from '@velaros-ai/core'

import type { PreparedPatch } from '../../types/edit.js'

export type { ProjectChangeLifecycle, ProjectChangeListener, ProjectChangeListOptions, ProjectChangePatch, ProjectChangeRecord, ProjectChangeRecordInput, ProjectChangeRevision } from '../../types/change-feed.js'

import type { ProjectChangeFeedWriter } from '../../contract/requires.js'
import type { ProjectChangeListener, ProjectChangeListOptions, ProjectChangePatch, ProjectChangeRecord, ProjectChangeRecordInput } from '../../types/change-feed.js'

function cloneChange(change: ProjectChangeRecord): ProjectChangeRecord {
  return structuredClone(change)
}

function isProjectChangeRecord(value: unknown): value is ProjectChangeRecord {
  if (!isObject(value)) return false
  const record = value as Partial<ProjectChangeRecord>
  return (
    isString(record.transactionId) &&
    Number.isSafeInteger(record.sequence) &&
    isString(record.lifecycle) &&
    isArray(record.intents) &&
    isArray(record.patches) &&
    isArray(record.changedFiles) &&
    isString(record.diff) &&
    isNumber(record.changedLines) &&
    isString(record.risk) &&
    isArray(record.revisions) &&
    isNumber(record.createdAt) &&
    isNumber(record.updatedAt)
  )
}

abstract class BaseProjectChangeFeed implements ProjectChangeFeedWriter {
  private readonly changes = new Map<string, ProjectChangeRecord>()
  private readonly listeners = new Set<ProjectChangeListener>()
  private lastSequence = 0

  protected hydrate(change: ProjectChangeRecord): void {
    if (change.sequence <= this.lastSequence) {
      throw new Error('Project change feed sequence must be strictly increasing')
    }
    this.lastSequence = change.sequence
    this.changes.set(change.transactionId, cloneChange(change))
  }

  protected abstract persist(change: ProjectChangeRecord): void

  public record(input: ProjectChangeRecordInput): ProjectChangeRecord {
    const change: ProjectChangeRecord = {
      ...cloneChange({
        ...input,
        sequence: this.lastSequence + 1,
        updatedAt: Date.now(),
      }),
    }
    this.persist(change)
    this.hydrate(change)
    const published = cloneChange(change)
    for (const listener of this.listeners) listener(cloneChange(published))
    return published
  }

  public list(options: ProjectChangeListOptions = {}): readonly ProjectChangeRecord[] {
    const before = options.beforeSequence ?? Number.POSITIVE_INFINITY
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)))
    return [...this.changes.values()]
      .filter((change) => change.sequence < before)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit)
      .map(cloneChange)
  }

  public get(transactionId: string): ProjectChangeRecord | undefined {
    const change = this.changes.get(transactionId)
    return change ? cloneChange(change) : undefined
  }

  public subscribe(listener: ProjectChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export class MemoryProjectChangeFeed extends BaseProjectChangeFeed {
  protected persist(_change: ProjectChangeRecord): void {}
}

export interface FileProjectChangeFeedOptions {
  /** Host-owned path outside the project tree is recommended. */
  readonly path: string
}

/**
 * Append-only JSONL feed. Each append is fsynced before subscribers observe it;
 * reopening reconstructs the latest transaction projection from lifecycle rows.
 */
export class FileProjectChangeFeed extends BaseProjectChangeFeed {
  public readonly path: string
  private readonly descriptor: number
  private closed = false

  public constructor(options: FileProjectChangeFeedOptions) {
    super()
    this.path = resolve(options.path)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    if (existsSync(this.path)) this.load(readFileSync(this.path, 'utf8'))
    this.descriptor = openSync(this.path, 'a', 0o600)
  }

  private load(source: string): void {
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      try {
        const change: unknown = JSON.parse(line)
        if (!isProjectChangeRecord(change)) throw new Error('invalid project change record')
        this.hydrate(change)
      } catch (error) {
        const isLastPartialLine = index === lines.length - 1 && !source.endsWith('\n')
        if (!isLastPartialLine) throw error
      }
    }
  }

  protected persist(change: ProjectChangeRecord): void {
    if (this.closed) throw new Error('Project change feed is closed')
    appendFileSync(this.descriptor, `${JSON.stringify(change)}\n`, 'utf8')
    fsyncSync(this.descriptor)
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.descriptor)
  }
}

export function projectChangePatches(
  patches: readonly PreparedPatch[],
): readonly ProjectChangePatch[] {
  return patches.map((patch) => ({
    patchId: patch.patchId,
    strategyId: patch.strategyId,
    path: patch.path,
    baseRevision: patch.baseRevision,
    diff: patch.diff,
    changedLines: patch.changedLines,
    risk: patch.risk,
    operation: isString(patch.metadata?.op) ? patch.metadata.op : undefined,
  }))
}
export type { ProjectChangeFeed } from '../../contract/provides.js'
export type { ProjectChangeFeedWriter } from '../../contract/requires.js'
