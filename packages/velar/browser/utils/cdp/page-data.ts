/** CDP 页面数据引擎里用不着实例状态的那部分：页面回包的归一与汇总。 */

import { isNotNull } from '@velaros-ai/core'
import { isFiniteNumber, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserPageDiagnostics } from '../../types/browser.js'
import { resolveWorkspaceFilePath } from '../workspace-paths.js'

/** 抓资源的 URL 归一；不是 http(s) 就报错。 */
export function normalizeFetchResourceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', 'url 不能为空。')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw new AppError('VALIDATION', `无效的资源 URL：${rawUrl}`, error)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION', '仅支持 http(s) 资源 URL。', undefined, {
      protocol: parsed.protocol,
    })
  }

  return parsed.toString()
}

/** 从 URL 推出它的 origin；推不出来就原样返回。 */
export function resolveOrigin(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : ''
}

/** 给计数表里的一项加一。 */
export function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

/** 计数表按数量从多到少排一遍。 */
export function sortCountRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  )
}

/** 从一条诊断里读出 HTTP 状态码。 */
export function readDiagnosticNetworkStatus(
  entry: BrowserPageDiagnostics['entries'][number]
): Nullable<number> {
  if (entry.kind !== 'network') return null

  const detailStatus = isPlainObject(entry.details) ? entry.details.status : null
  const status = isFiniteNumber(detailStatus) ? detailStatus : entry.code
  if (!isFiniteNumber(status) || status <= 0) return null

  return Math.round(status)
}

/** 从一条诊断里读出资源类型。 */
export function readDiagnosticResourceType(
  entry: BrowserPageDiagnostics['entries'][number]
): Nullable<string> {
  if (entry.kind !== 'network') return null
  if (!isPlainObject(entry.details)) return null

  const resourceType = entry.details.resourceType
  if (!isString(resourceType)) return null

  return resourceType.trim() || null
}

/** 把上传用的相对路径解析成真实路径，并确认它没走出站点工作区。 */
export async function resolveUploadFilePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  return (await resolveWorkspaceFilePath(workspaceRoot, requestedPath, 'filePath')).path
}

/**
 * 媒体项尺寸归一：非有限值与 0 都记为缺席。0 宽/高的媒体项对调用方没有可用信息，
 * 保持与旧实现一致的「假值即 null」语义，避免把占位元素当成真实媒体。
 */
/** 把一批诊断按级别、种类、来源、状态码和资源类型各聚合一份。 */
export function summarizePageDiagnostics(
  entries: BrowserPageDiagnostics['entries']
): BrowserPageDiagnostics['summary'] {
  const byLevel: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byOrigin: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byResourceType: Record<string, number> = {}

  for (const entry of entries) {
    incrementCount(byLevel, entry.level)
    incrementCount(byKind, entry.kind)

    const origin = entry.url ? resolveOrigin(entry.url) : ''
    if (origin) incrementCount(byOrigin, origin)

    const status = readDiagnosticNetworkStatus(entry)
    if (isNotNull(status)) incrementCount(byStatus, String(status))

    const resourceType = readDiagnosticResourceType(entry)
    if (resourceType) incrementCount(byResourceType, resourceType)
  }

  return {
    total: entries.length,
    byLevel: sortCountRecord(byLevel),
    byKind: sortCountRecord(byKind),
    byOrigin: sortCountRecord(byOrigin),
    byStatus: sortCountRecord(byStatus),
    byResourceType: sortCountRecord(byResourceType),
  }
}

