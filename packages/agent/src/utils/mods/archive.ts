import { posix } from 'node:path'

import { isArray, isEmpty, isPlainObject, trimmedStringOrEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { VelarModArchiveInstallFailureReason } from '../../types/mods.js'

export const MaxPathLength = 240

export const MaxPathDepth = 8

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export function assertArchiveEntryPath(rawPath: string): string {
  if (
    rawPath.startsWith('/')
    || /^[a-z]:\//iu.test(rawPath)
    || rawPath.includes('\\')
    || rawPath.length > MaxPathLength
    || hasControlCharacter(rawPath)
  ) throw new AppError(
    'SECURITY',
    `Mod archive contains an unsafe path: ${JSON.stringify(rawPath)}`,
    undefined,
    { reason: 'archive.path-unsafe' satisfies VelarModArchiveInstallFailureReason },
  )

  const normalized = posix.normalize(rawPath)
  const segments = normalized.split('/')
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || segments.includes('..')
    || segments.length > MaxPathDepth
  ) throw new AppError(
    'SECURITY',
    `Mod archive path escapes its root or is too deep: ${JSON.stringify(rawPath)}`,
    undefined,
    { reason: 'archive.path-escapes-root' satisfies VelarModArchiveInstallFailureReason },
  )
  return normalized.normalize('NFC')
}

export function readText(value: unknown): string {
  return trimmedStringOrEmpty(value)
}

export function readAgentMetadata(agent: unknown, fallbackId: string) {
  if (!isPlainObject(agent)) return { displayName: fallbackId, description: '', publisher: '', claimedTrust: '' }
  return {
    displayName: readText(agent.displayName) || fallbackId,
    description: readText(agent.description),
    publisher: readText(agent.publisher),
    claimedTrust: readText(agent.trust),
  }
}

export function countContributions(agent: unknown): Readonly<Record<string, number>> {
  if (!isPlainObject(agent) || !isPlainObject(agent.contributes)) return {}
  return Object.fromEntries(
    Object.entries(agent.contributes)
      .filter(([, entries]) => isArray(entries) && !isEmpty(entries))
      .map(([axis, entries]) => [axis, (entries as readonly unknown[]).length]),
  )
}
