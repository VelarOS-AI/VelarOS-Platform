import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n/conversationTranslator'

import { getToolCategoryLabel, getToolDescriptionText } from './toolPresentation'

import type { AppLocale, ToolCallBlock, ToolCategoryId } from '#contracts'
import { platformCompatibility } from '#internal/platform'
import { isBlank, isEmpty, isFalse, isFiniteNumber, isNonBlankString, isPresent, toNullable } from '#internal/runtime'
import { asRecord, readNumber, readString, readStringArray } from '#internal/unknownJsonRecord'

type PathDisplayFormatter = (path: string) => string

/**
 * 把相对路径先 join 到 cwd 再交给 formatter，使路径显示与实际工作目录对齐。
 * 只有当 cwd 是绝对路径且 path 是相对路径时才 join，其余直接透传。
 */
function wrapFormatterWithCwd(
  formatter: LooseOptional<PathDisplayFormatter>,
  cwd: LooseOptional<string>
): Nullable<PathDisplayFormatter> {
  if (
    !formatter ||
    !isPresent(cwd) ||
    !cwd.trim() ||
    !platformCompatibility.isAbsolutePathText(cwd.trim())
  ) return toNullable(formatter)

  const normalizedCwd = cwd.trim()

  return (path: string) => {
    const normalizedPath = path.trim()
    const resolved =
      !normalizedPath ||
      platformCompatibility.isAbsolutePathText(normalizedPath) ||
      /^~[\\/]/.test(normalizedPath)
        ? normalizedPath
        : platformCompatibility.joinPathText(
            normalizedCwd,
            platformCompatibility.stripLeadingPathTextSeparators(normalizedPath)
          )

    return formatter(resolved)
  }
}

function truncateInline(text: string, maxLength = 64): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized

  return `${normalized.slice(0, maxLength - 1)}…`
}

/** Collapse runs of whitespace to single spaces and trim (shared tool/debug display helper). */
export function normalizeInline(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

function compactPath(path: string, maxSegments = 2): string {
  const normalized = platformCompatibility.normalizePathTextForComparison(path)
  const segments = normalized.split('/').filter((value) => !!value)

  if (isEmpty(segments)) return path

  if (segments.length <= maxSegments) return segments.join('/')

  return `…/${segments.slice(-maxSegments).join('/')}`
}

function formatPath(path: string, formatter?: LooseOptional<PathDisplayFormatter>): string {
  return formatter ? formatter(path) : compactPath(path, 3)
}

function formatCommand(command: string, formatter?: LooseOptional<PathDisplayFormatter>): string {
  return formatter ? formatter(command) : command
}

const SensitiveCliArgNames = new Set([
  'api-key',
  'apikey',
  'auth-token',
  'authorization',
  'bearer',
  'client-secret',
  'password',
  'passwd',
  'private-key',
  'refresh-token',
  'secret',
  'token',
  'access-token',
])

function normalizeCliArgFlagName(flag: string): string {
  return flag.replace(/^-+/u, '').replaceAll('_', '-').toLowerCase()
}

function isSensitiveCliArgFlag(flag: string): boolean {
  return SensitiveCliArgNames.has(normalizeCliArgFlagName(flag))
}

function formatCliArgToken(token: string): string {
  const normalized = token.trim()
  if (!/[\s"'\\]/u.test(normalized)) return normalized

  return JSON.stringify(normalized)
}

function formatCliArgvPreview(argv: string[]): Nullable<string> {
  if (isEmpty(argv)) return null

  const parts: string[] = []
  let redactNextValue = false

  for (const arg of argv) {
    if (redactNextValue) {
      parts.push('[redacted]')
      redactNextValue = false
      continue
    }

    const inlineValueIndex = arg.indexOf('=')
    if (inlineValueIndex > 0) {
      const flag = arg.slice(0, inlineValueIndex)
      if (isSensitiveCliArgFlag(flag)) {
        parts.push(`${formatCliArgToken(flag)}=[redacted]`)
        continue
      }
    }

    parts.push(formatCliArgToken(arg))
    if (arg.startsWith('-') && isSensitiveCliArgFlag(arg)) redactNextValue = true
  }

  return truncateInline(parts.join(' '), 180)
}

function formatCategory(
  categoryId: string,
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  return locale ? getToolCategoryLabel(categoryId as ToolCategoryId, locale, undefined, runtime) : categoryId
}

function formatCategories(
  categories: string[],
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  if (isEmpty(categories)) return null

  const separator = locale ? runtime.translate(locale, 'common.shortListSeparator') : ', '
  return categories.map((category) => formatCategory(category, locale, runtime)).join(separator)
}

function formatToolSpaceTarget(
  target: string,
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  const match = /^(capability|category|tool|plugin):(.+)$/.exec(target)
  if (!match) return target

  const [, kind, id] = match
  if (kind === 'capability' || kind === 'category') return formatCategory(id, locale, runtime)

  return id
}

function formatToolSpaceTargets(
  targets: string[],
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  if (isEmpty(targets)) return null

  const separator = locale ? runtime.translate(locale, 'common.shortListSeparator') : ', '
  return targets.map((target) => formatToolSpaceTarget(target, locale, runtime)).join(separator)
}

function getToolReadSkillNames(toolName: string, args: Nullable<Record<string, any>>): string[] {
  if (toolName !== 'tooling:read') return []

  return readStringArray(args, 'ids')
    .map((id) => id.trim().replace(/^skill:/iu, '').trim())
    .filter((id) => !isBlank(id))
}

/**
 * `context:distill` 没有 path/query 这类通用主参数；它真正有用的行内信息是阶段便签，
 * 其次才是首条蒸馏事实。若这里不认 `note/facts`，紧凑工具行就只剩工具名，用户无法判断
 * 这次上下文整理保存了什么进度。
 */
function getContextDistillPreview(
  toolName: string,
  args: Nullable<Record<string, any>>
): Nullable<string> {
  if (toolName !== 'context:distill') return null

  const note = readString(args, 'note')
  if (note && !isBlank(note)) return normalizeInline(note)

  const firstFact = readStringArray(args, 'facts').find((fact) => !isBlank(fact))
  return firstFact ? normalizeInline(firstFact) : null
}

function formatToolReadSkillNames(
  toolName: string,
  args: Nullable<Record<string, any>>,
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  const skillNames = getToolReadSkillNames(toolName, args)
  if (isEmpty(skillNames)) return null

  const separator = locale ? runtime.translate(locale, 'common.shortListSeparator') : ', '
  return skillNames.join(separator)
}

function getPrimaryArgPreview(
  args: Nullable<Record<string, any>>,
  pathFormatter?: LooseOptional<PathDisplayFormatter>,
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  const pathPreview = [
    readString(args, 'path'),
    readString(args, 'targetPath'),
    readString(args, 'rootPath'),
    readString(args, 'fromPath'),
    readString(args, 'toPath'),
  ]
    .filter((value): value is string => !!value && !isBlank(value))
    .map((value) => formatPath(value, pathFormatter))[0]

  if (pathPreview) return pathPreview

  const commandPreview = readString(args, 'command')
  const cliArgvPreview = formatCliArgvPreview(readStringArray(args, 'args'))
  const textPreview = [
    readString(args, 'query'),
    readString(args, 'symbol'),
    commandPreview ? formatCommand(commandPreview, pathFormatter) : null,
    cliArgvPreview,
    readString(args, 'url'),
    readString(args, 'application'),
    readString(args, 'title'),
  ].find((value): value is string => !!value && !isBlank(value))

  if (textPreview) return normalizeInline(textPreview)

  const paths = readStringArray(args, 'paths')
  if (paths.length) return formatPath(paths[0], pathFormatter)

  const categoriesPreview = formatCategories(readStringArray(args, 'categories'), locale, runtime)
  if (categoriesPreview) return categoriesPreview

  const toolSpaceTargetsPreview = formatToolSpaceTargets(
    [...readStringArray(args, 'pageIn'), ...readStringArray(args, 'pageOut')],
    locale,
    runtime
  )
  if (toolSpaceTargetsPreview) return toolSpaceTargetsPreview

  return null
}

export function getToolDetailItems(
  block: Pick<ToolCallBlock, 'toolName' | 'args'>,
  pathFormatter?: LooseOptional<PathDisplayFormatter>,
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string[] {
  const args = asRecord(block.args)
  const cwd = readString(args, 'cwd')
  const cwdFormatter = wrapFormatterWithCwd(pathFormatter, cwd)
  const details: string[] = []
  const pathValues = [
    readString(args, 'path'),
    readString(args, 'targetPath'),
    readString(args, 'rootPath'),
    readString(args, 'fromPath'),
    readString(args, 'toPath'),
  ]
  const commandText = readString(args, 'command')
  const cliArgvPreview = formatCliArgvPreview(readStringArray(args, 'args'))
  const textValues = [
    readString(args, 'query'),
    readString(args, 'symbol'),
    commandText ? formatCommand(commandText, cwdFormatter) : null,
    cliArgvPreview,
    readString(args, 'url'),
    readString(args, 'application'),
    readString(args, 'title'),
  ]
  const pushDetail = (detail: Nullable<string>): void => {
    if (!detail || isBlank(detail) || details.includes(detail)) return

    details.push(detail)
  }

  pushDetail(getContextDistillPreview(block.toolName, args))
  if (!isEmpty(details)) return details

  getToolReadSkillNames(block.toolName, args).forEach(pushDetail)
  if (!isEmpty(details)) return details

  readStringArray(args, 'paths').forEach((path) => pushDetail(formatPath(path, cwdFormatter)))
  pathValues.forEach((path) => pushDetail(path ? formatPath(path, cwdFormatter) : null))
  readStringArray(args, 'categories').forEach((category) =>
    pushDetail(formatCategory(category, locale, runtime))
  )
  ;[...readStringArray(args, 'pageIn'), ...readStringArray(args, 'pageOut')].forEach((target) =>
    pushDetail(formatToolSpaceTarget(target, locale, runtime))
  )

  if (!isEmpty(details)) return details

  textValues.forEach((text) => pushDetail(text ? normalizeInline(text) : null))

  return details
}

function buildResultSummary(
  result: Nullable<Record<string, any>>,
  locale: AppLocale,
  runtime: ConversationTranslator
): Nullable<string> {
  if (!result) return null

  const count = readNumber(result, 'count')
  if (isPresent(count)) return count === 0
      ? runtime.translate(locale, 'toolSummary.noResults')
      : runtime.translate(locale, 'toolSummary.resultCount', { count })

  return isFalse(result?.found) ? runtime.translate(locale, 'toolSummary.noResults') : null
}

function readDurationFromResult(result: any): Nullable<number> {
  const record = asRecord(result)
  return readNumber(record, 'durationMs') ?? readNumber(record, 'elapsedMs')
}

function isFiniteTimestamp(value: any): value is number {
  return isFiniteNumber(value) && value >= 0
}

/**
 * 单个工具自己的耗时。工具结果带着耗时就用它；否则从执行器记下的执行开始时刻（元数据
 * `executionStartedAt`）算到结束——宿主的 startedAt 是调用到达的时刻，同一批里排在有副作用工具
 * 后面等待的时间会被算进来，显示成像是几个工具的累计。
 */
export function getToolDurationMs(
  block: Pick<ToolCallBlock, 'startedAt' | 'finishedAt' | 'result' | 'metadata'>
): Nullable<number> {
  const resultDurationMs = readDurationFromResult(block.result)
  if (isPresent(resultDurationMs)) return resultDurationMs

  const executionStartedAt = readNumber(asRecord(block.metadata), 'executionStartedAt')
  const startedAt = isFiniteTimestamp(executionStartedAt) ? executionStartedAt : block.startedAt
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(block.finishedAt)) return Math.max(0, block.finishedAt - startedAt)

  return null
}

function shouldShowToolDurationMs(durationMs: Nullable<number>): durationMs is number {
  return isPresent(durationMs) && Math.max(0, Math.round(durationMs)) > 0
}

export function formatToolDurationMs(
  durationMs: number,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  const safeDurationMs = Math.max(0, Math.round(durationMs))

  if (safeDurationMs < 1000) return `${safeDurationMs}ms`

  const totalSeconds = Math.max(1, Math.round(safeDurationMs / 1000))
  if (totalSeconds < 60)
    return runtime.translate(locale, 'status.elapsedSeconds', { seconds: totalSeconds })

  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return runtime.translate(locale, 'status.elapsedMinutesSeconds', {
      minutes: totalMinutes,
      seconds,
    })

  return runtime.translate(locale, 'status.elapsedHoursMinutes', {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  })
}

export function getToolStatusLabel(
  block: Pick<ToolCallBlock, 'isRunning' | 'startedAt' | 'finishedAt' | 'result' | 'metadata'>,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  if (block.isRunning) return runtime.translate(locale, 'toolSummary.running')

  const durationMs = getToolDurationMs(block)
  return shouldShowToolDurationMs(durationMs)
    ? formatToolDurationMs(durationMs, locale, runtime)
    : null
}

/**
 * 一组工具实际占用的时间：各自执行区间的并集。并发执行的工具区间互相重叠，直接相加会把同一段时间
 * 算好几遍；串行的区间首尾相接，并集就是各自耗时之和。定位不出区间（没有结束时刻）的按耗时相加。
 */
function getToolGroupDurationMs(
  blocks: Array<Pick<ToolCallBlock, 'startedAt' | 'finishedAt' | 'result' | 'metadata'>>
): number {
  const intervals: Array<{ start: number; end: number }> = []
  let unplacedDurationMs = 0
  for (const block of blocks) {
    const durationMs = getToolDurationMs(block)
    if (!isPresent(durationMs)) continue
    if (isFiniteTimestamp(block.finishedAt)) intervals.push({ start: block.finishedAt - durationMs, end: block.finishedAt })
    else unplacedDurationMs += durationMs
  }

  intervals.sort((left, right) => left.start - right.start)
  let coveredDurationMs = 0
  let coveredUntil = Number.NEGATIVE_INFINITY
  for (const interval of intervals) {
    const start = Math.max(interval.start, coveredUntil)
    if (interval.end > start) coveredDurationMs += interval.end - start
    coveredUntil = Math.max(coveredUntil, interval.end)
  }

  return coveredDurationMs + unplacedDurationMs
}

export function getToolGroupStatusLabel(
  blocks: Array<Pick<ToolCallBlock, 'isRunning' | 'startedAt' | 'finishedAt' | 'result' | 'metadata'>>,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  if (blocks.some((block) => block.isRunning))
    return runtime.translate(locale, 'toolSummary.running')

  const totalDurationMs = getToolGroupDurationMs(blocks)

  return shouldShowToolDurationMs(totalDurationMs)
    ? formatToolDurationMs(totalDurationMs, locale, runtime)
    : null
}

export function getMergedToolGroupStatusLabel(
  blocks: Array<Pick<ToolCallBlock, 'isRunning' | 'startedAt' | 'finishedAt' | 'result' | 'metadata'>>,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  const statusLabel = getToolGroupStatusLabel(blocks, locale, runtime)
  if (blocks.length <= 1) return statusLabel

  const countLabel = `×${blocks.length}`
  return statusLabel ? `${statusLabel} · ${countLabel}` : countLabel
}

export function getToolActivitySummary(
  block: Pick<ToolCallBlock, 'toolName' | 'args' | 'isRunning'>,
  locale: AppLocale,
  pathFormatter?: LooseOptional<PathDisplayFormatter>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  const args = asRecord(block.args)
  const cwdFormatter = wrapFormatterWithCwd(pathFormatter, readString(args, 'cwd'))
  const displayName = block.toolName
  const preview =
    formatToolReadSkillNames(block.toolName, args, locale, runtime) ??
    getPrimaryArgPreview(args, cwdFormatter, locale, runtime)
  const action = preview ? `${displayName} · ${preview}` : displayName

  return block.isRunning
    ? runtime.translate(locale, 'toolSummary.runningAction', { action })
    : action
}

export function getToolDetailSummary(
  block: Pick<ToolCallBlock, 'toolName' | 'args'>,
  pathFormatter?: LooseOptional<PathDisplayFormatter>,
  locale?: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  const args = asRecord(block.args)
  const cwdFormatter = wrapFormatterWithCwd(pathFormatter, readString(args, 'cwd'))
  return (
    getContextDistillPreview(block.toolName, args) ??
    formatToolReadSkillNames(block.toolName, args, locale, runtime) ??
    getPrimaryArgPreview(args, cwdFormatter, locale, runtime)
  )
}

export function getToolResultSummary(
  block: Pick<ToolCallBlock, 'toolName' | 'result'>,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  return buildResultSummary(asRecord(block.result), locale, runtime)
}

export function getToolDescription(
  block: Pick<ToolCallBlock, 'toolName' | 'args' | 'result' | 'error' | 'isRunning'>,
  locale: AppLocale,
  pathFormatter?: LooseOptional<PathDisplayFormatter>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string | undefined {
  const detail = getToolDetailSummary(block, pathFormatter, locale, runtime)
  const staticDescription = getToolDescriptionText(block.toolName, locale, undefined, runtime)

  if (block.error) {
    const compactError = truncateInline(block.error, 88)
    const description = [detail, compactError].filter((value) => !!value).join(' · ')
    return isBlank(description) ? compactError : description
  }

  if (block.isRunning)
    return detail ?? staticDescription ?? runtime.translate(locale, 'toolSummary.running')

  const resultSummary = getToolResultSummary(block, locale, runtime)
  const description = [detail, resultSummary].filter((value) => !!value).join(' · ')
  if (!isBlank(description)) return description
  if (!isPresent(staticDescription)) return undefined
  return staticDescription
}

export function getToolGroupPreview(
  blocks: ToolCallBlock[],
  locale: AppLocale,
  pathFormatter?: LooseOptional<PathDisplayFormatter>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string | undefined {
  const previews = blocks
    .map((block) => getToolActivitySummary(block, locale, pathFormatter, runtime))
    .filter((value): value is string => isNonBlankString(value))
    .filter((value, index, items) => items.indexOf(value) === index)

  if (isEmpty(previews)) return undefined

  const primary = previews[0]
  return blocks.length > 1
    ? runtime.translate(locale, 'toolSummary.groupMultiple', {
        primary,
        count: blocks.length,
      })
    : primary
}
