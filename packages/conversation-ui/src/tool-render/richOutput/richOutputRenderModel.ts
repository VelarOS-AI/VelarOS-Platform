import type { ConversationMessageKey } from '../../i18n'
import { normalizeInline } from '../toolCallSummary'

import { isArray, isNumber, isPresent, isString, isUndefined, Log, toOptional } from '#internal/runtime'
import {
  readNumberScalar as readNumber,
  readRecord,
  readStringScalar as readString,
} from '#internal/unknownJsonRecord'

export { readNumber, readRecord, readString }

const log = Log.tag('rich-output-render-model')

export interface SearchResultItem {
  title: string
  url: string
  content: string
  score?: number
  sourceId?: string
}

export interface MemoryItem {
  id: string
  kind: string
  title: string
  summary?: string
  content?: string
  source?: string
  tags?: string[]
  createdAt?: number
  updatedAt?: number
  score?: number
  snippet?: string
}

export interface GitCommitItem {
  hash: string
  shortHash: string
  authorName: string
  authorEmail?: string
  date: string
  subject: string
  refs?: string
}

export function readArray(value: unknown): unknown[] {
  return isArray(value) ? value : []
}

function stripUndefinedFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => !isUndefined(entryValue))
  ) as T
}

export function compactText(text: string, maxLength: number): string {
  const normalized = normalizeInline(text)
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

export function formatCount(count: Nullable<number>, fallback: number): string {
  return String(count ?? fallback)
}

export function formatBytes(value: Nullable<number>): Nullable<string> {
  if (!isPresent(value)) return null

  if (value < 1024) return `${value} B`

  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`

  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function formatDate(value: unknown, locale: string): Nullable<string> {
  const date = isNumber(value) ? new Date(value) : isString(value) ? new Date(value) : null

  if (!date || Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function getUrlHost(url: string): Nullable<string> {
  try {
    return new URL(url).hostname
  } catch (error) {
    log.debug('解析富输出 URL host 失败，隐藏 host 标签', {
      url,
      error: String(error),
    })
    return null
  }
}

export function normalizeSearchResultItems(
  resultsUnknown: unknown,
  untitledLabel: string
): SearchResultItem[] {
  return readArray(resultsUnknown)
    .map(readRecord)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => {
      const score = readNumber(item.score)
      const sourceId = readString(item.source_id)
      return stripUndefinedFields({
        title: readString(item.title) ?? readString(item.url) ?? untitledLabel,
        url: readString(item.url) ?? '',
        content: readString(item.content) ?? '',
        score: toOptional(score),
        sourceId: toOptional(sourceId),
      })
    })
    .filter((item) => item.url || item.content)
}

export function readMemoryItems(result: Nullable<Record<string, unknown>>): MemoryItem[] {
  return readArray(result?.memories ?? result?.results)
    .map(readRecord)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => {
      const summary = readString(item.summary)
      const content = readString(item.content)
      const source = readString(item.source)
      const createdAt = readNumber(item.createdAt)
      const updatedAt = readNumber(item.updatedAt)
      const score = readNumber(item.score)
      const snippet = readString(item.snippet)
      return stripUndefinedFields({
        id: readString(item.id) ?? '',
        kind: readString(item.kind) ?? 'memory',
        title: readString(item.title) ?? 'Memory',
        summary: toOptional(summary),
        content: toOptional(content),
        source: toOptional(source),
        tags: readArray(item.tags).filter((tag): tag is string => isString(tag)),
        createdAt: toOptional(createdAt),
        updatedAt: toOptional(updatedAt),
        score: toOptional(score),
        snippet: toOptional(snippet),
      })
    })
}

export function readGitCommits(result: Nullable<Record<string, unknown>>): GitCommitItem[] {
  return readArray(result?.commits)
    .map(readRecord)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => {
      const authorEmail = readString(item.authorEmail)
      const refs = readString(item.refs)
      return stripUndefinedFields({
        hash: readString(item.hash) ?? '',
        shortHash: readString(item.shortHash) ?? readString(item.hash)?.slice(0, 7) ?? '',
        authorName: readString(item.authorName) ?? '',
        authorEmail: toOptional(authorEmail),
        date: readString(item.date) ?? '',
        subject: readString(item.subject) ?? '',
        refs: toOptional(refs),
      })
    })
}

export function getMemoryTitle(
  toolName: string,
  t: (key: ConversationMessageKey) => string,
  mode?: Nullable<string>
): string {
  if (toolName === 'search_memories') {
    switch (mode) {
      case 'browse':
        return t('chat.richMemoryBrowseTitle')
      case 'entity':
        return t('chat.richMemoryEntityTitle')
      case 'profile':
        return t('chat.richUserProfileTitle')
      default:
        return t('chat.richMemoryRecallTitle')
    }
  }

  return t('chat.richMemoryRecallTitle')
}
