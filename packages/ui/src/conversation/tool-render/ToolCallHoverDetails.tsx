/**
 * 工具调用行的悬停详情：这次调用实际执行了哪些操作、作用在什么对象上、结果如何。
 *
 * 单次调用逐项列出操作（一次批量编辑里的每一项），再补完整描述、结果或错误；归并行（×N）按调用
 * 顺序每次调用占一行。内容先推导成纯数据（`describeToolCallHover`），再渲染：行据此判断气泡比行
 * 多不多出信息（`doesToolCallHoverAddToRow`），多不出就不挂气泡——见 `resolveToolCallHoverContent`。
 */
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'

import {
  type ConversationTranslator,
  useConversationI18n,
  useConversationTranslatorRuntime,
} from '../i18n'

import { isCommandToolName } from './toolActivityPredicates'
import {
  getToolDetailItems,
  getToolDetailSummary,
  getToolGroupStatusLabel,
  getToolResultSummary,
  getToolSearchScopeItems,
  getToolStatusLabel,
  normalizeInline,
} from './toolCallSummary'
import { getToolOperations, type ToolOperationSummary } from './toolOperationSummary'
import { getToolDescriptionText } from './toolPresentation'

import styles from './ToolCallHoverDetails.module.css'

import type { AppLocale, ToolCallBlock } from '#contracts'
import { isEmpty, isNonBlankString, isString, optionalWhen, truncate } from '#internal/runtime'
import { asRecord, readString } from '#internal/unknownJsonRecord'

const cx = StyleUtils.bindCx(styles)
const MaxListedOperations = 20
const MaxListedCalls = 20
const MaxChipsPerCall = 3
const MaxErrorLength = 1200

type PathDisplayFormatter = (path: string) => string

export interface ToolCallHoverDetailsProps {
  /** 单次调用传一个；归并行（×N）按调用顺序传入全部成员。 */
  blocks: readonly ToolCallBlock[]
  formatPathForDisplay?: PathDisplayFormatter
  /**
   * 单次调用时渲染器已算好的完整描述：字符串作为一段展示（命令可以带换行），数组一项一行；
   * 缺省按参数推导。与操作对象、摘要或错误重复的内容会被略去。
   */
  detail?: string | readonly string[]
  /** 单次调用时渲染器已算好的结果或状态摘要；缺省按结果计数推导。 */
  summary?: string
}

/** 紧凑行上已经看得到的文字：工具名（或标题）、行内描述、状态或计数。 */
export interface ToolCallHoverRowText {
  label?: LooseOptional<string>
  detail?: LooseOptional<string>
  status?: LooseOptional<string>
}

export interface ToolCallHoverOperationRow {
  operation: ToolOperationSummary
  count: number
}

export interface ToolCallHoverCall {
  toolCallId: string
  chips: string[]
  hiddenChipCount: number
  target: Nullable<string>
  statusLabel: Nullable<string>
  errorText: Nullable<string>
}

/** 单次调用的气泡内容。 */
export interface SingleToolCallHover {
  kind: 'single'
  toolName: string
  status: Nullable<string>
  operationRows: ToolCallHoverOperationRow[]
  hiddenOperationCount: number
  detailLines: string[]
  codeDetail: boolean
  summaryText: Nullable<string>
  errorText: Nullable<string>
  /** 什么都推不出时退回的工具自身说明。 */
  fallbackDescription: Nullable<string>
}

/** 归并行（×N）的气泡内容：按调用顺序每次调用一行。 */
export interface MergedToolCallHover {
  kind: 'merged'
  toolName: string
  callCount: number
  groupStatus: Nullable<string>
  calls: ToolCallHoverCall[]
  hiddenCallCount: number
  codeTarget: boolean
}

export type ToolCallHover = SingleToolCallHover | MergedToolCallHover

function readToolErrorText(block: Pick<ToolCallBlock, 'error'>): Nullable<string> {
  const error: unknown = block.error
  // 契约上是字符串，但磁盘归档与流式归约可能留下 `{ message }` 形状。
  const text = isString(error) ? error.trim() : readString(asRecord(error), 'message')
  return isNonBlankString(text) ? text : null
}

/** 错误全文可能是整段堆栈；气泡里给足上下文即可，比对去重时仍用全文。 */
function clampErrorText(errorText: string): string {
  return truncate(errorText, MaxErrorLength)
}

function toOptionalText(value: LooseOptional<string>): Nullable<string> {
  return isNonBlankString(value) ? value.trim() : null
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** 同一对象上连续的同类操作合成一行并计数（比如同一文件上的几处 replace_text）。 */
function collapseRepeatedOperations(
  operations: readonly ToolOperationSummary[]
): ToolCallHoverOperationRow[] {
  const rows: ToolCallHoverOperationRow[] = []
  for (const operation of operations) {
    const previous = rows.at(-1)
    if (previous?.operation.id === operation.id && previous.operation.target === operation.target) {
      previous.count += 1
      continue
    }
    rows.push({ operation, count: 1 })
  }
  return rows
}

function resolveDetailLines({
  block,
  detail,
  operations,
  excluded,
  formatPathForDisplay,
  locale,
  runtime,
}: {
  block: ToolCallBlock
  detail: Optional<string | readonly string[]>
  operations: readonly ToolOperationSummary[]
  excluded: ReadonlyArray<Nullable<string>>
  formatPathForDisplay: Optional<PathDisplayFormatter>
  locale: AppLocale
  runtime: ConversationTranslator
}): string[] {
  const source = isString(detail)
    ? [detail]
    : (detail ?? [
        ...getToolDetailItems(block, formatPathForDisplay, locale, runtime),
        ...getToolSearchScopeItems(block, formatPathForDisplay),
      ])
  const operationTargets = operations.flatMap((operation) => (operation.target ? [operation.target] : []))
  const lines: string[] = []

  for (const rawLine of source) {
    const line = rawLine.trim()
    if (!line || lines.includes(line) || excluded.includes(line)) continue
    // 操作行已经点名的对象不再重复一遍。
    if (operationTargets.some((target) => target.includes(line))) continue
    lines.push(line)
  }

  return lines
}

function describeSingleCall(
  block: ToolCallBlock,
  { formatPathForDisplay, detail, summary }: Omit<ToolCallHoverDetailsProps, 'blocks'>,
  locale: AppLocale,
  runtime: ConversationTranslator
): SingleToolCallHover {
  const operations = getToolOperations(block, formatPathForDisplay)
  const errorText = readToolErrorText(block)
  const providedSummary = toOptionalText(summary)
  // 渲染器的摘要就是错误本身时只按错误展示一次；出错时也不再补结果计数。
  const summaryText =
    providedSummary && providedSummary !== errorText
      ? providedSummary
      : errorText
        ? null
        : getToolResultSummary(block, locale, runtime)
  const detailLines = resolveDetailLines({
    block,
    detail,
    operations,
    excluded: [errorText, summaryText],
    formatPathForDisplay,
    locale,
    runtime,
  })
  const operationRows = collapseRepeatedOperations(operations).slice(0, MaxListedOperations)
  const hiddenOperationCount =
    operations.length - operationRows.reduce((total, row) => total + row.count, 0)
  const hasBody = !isEmpty(operations) || !isEmpty(detailLines) || !!summaryText || !!errorText

  return {
    kind: 'single',
    toolName: block.toolName,
    status: getToolStatusLabel(block, locale, runtime),
    operationRows,
    hiddenOperationCount,
    detailLines,
    codeDetail: isCommandToolName(block.toolName),
    summaryText,
    errorText,
    fallbackDescription: hasBody ? null : getToolDescriptionText(block.toolName, locale, undefined, runtime),
  }
}

function describeMergedCall(
  block: ToolCallBlock,
  formatPathForDisplay: Optional<PathDisplayFormatter>,
  locale: AppLocale,
  runtime: ConversationTranslator
): ToolCallHoverCall {
  const operations = getToolOperations(block, formatPathForDisplay)
  const operationIds = uniqueStrings(operations.map((operation) => operation.id))
  const targets = uniqueStrings(
    operations.flatMap((operation) => (operation.target ? [operation.target] : []))
  )
  const [firstTarget] = targets
  const operationTarget =
    firstTarget && targets.length > 1 ? `${firstTarget} +${targets.length - 1}` : firstTarget

  return {
    toolCallId: block.toolCallId,
    chips: operationIds.slice(0, MaxChipsPerCall),
    hiddenChipCount: Math.max(0, operationIds.length - MaxChipsPerCall),
    target: operationTarget ?? getToolDetailSummary(block, formatPathForDisplay, locale, runtime),
    statusLabel: getToolStatusLabel(block, locale, runtime),
    errorText: readToolErrorText(block),
  }
}

/**
 * 推导气泡要展示的内容（纯数据，不渲染）。一个 block 按单次调用，多个按归并行逐次调用；
 * 没有 block 时返回 null。
 */
export function describeToolCallHover(
  { blocks, ...options }: ToolCallHoverDetailsProps,
  locale: AppLocale,
  runtime: ConversationTranslator
): Nullable<ToolCallHover> {
  const [firstBlock] = blocks
  if (!firstBlock) return null
  if (blocks.length === 1) return describeSingleCall(firstBlock, options, locale, runtime)

  const visibleBlocks = blocks.slice(0, MaxListedCalls)
  return {
    kind: 'merged',
    // 归并按工具名分组，成员工具名一致，取首个即可。
    toolName: firstBlock.toolName,
    callCount: blocks.length,
    groupStatus: getToolGroupStatusLabel([...blocks], locale, runtime),
    calls: visibleBlocks.map((block) =>
      describeMergedCall(block, options.formatPathForDisplay, locale, runtime)
    ),
    hiddenCallCount: blocks.length - visibleBlocks.length,
    codeTarget: isCommandToolName(firstBlock.toolName),
  }
}

/** 截断出来的对象文字会带省略号，比对时去掉，免得同一段文字因为被截短而算成「多出来的」。 */
function toComparableText(text: string): string {
  return normalizeInline(text).replace(/…+$/u, '').trimEnd()
}

const AsciiWordCharacterPattern = /\w/u

function isAsciiWordCharacter(character: LooseOptional<string>): boolean {
  return !!character && AsciiWordCharacterPattern.test(character)
}

/**
 * 行上是否原样出现这段文字。以英文字母、数字开头或结尾的一端要落在词边界上：
 * 操作标识 `all` 不能算作出现在 `context:recall` 里。
 */
function includesAsToken(rowText: string, text: string): boolean {
  const checksStart = isAsciiWordCharacter(text[0])
  const checksEnd = isAsciiWordCharacter(text.at(-1))
  let index = rowText.indexOf(text)
  while (index >= 0) {
    const startsClean = !checksStart || !isAsciiWordCharacter(rowText[index - 1])
    const endsClean = !checksEnd || !isAsciiWordCharacter(rowText[index + text.length])
    if (startsClean && endsClean) return true
    index = rowText.indexOf(text, index + 1)
  }
  return false
}

function isShownOnRow(text: LooseOptional<string>, rowText: string): boolean {
  if (!isNonBlankString(text)) return true

  const comparable = toComparableText(text)
  return !comparable || includesAsToken(rowText, comparable)
}

/**
 * 气泡是否说出了行上没有的东西。「多不出」的精确定义：气泡正文里的每一段——操作标识与其对象、
 * 详情行、结果摘要、错误、兜底说明；归并行则是每次调用的操作标识、对象与错误——都已经原样出现在
 * 行上（工具名、行内描述、状态计数拼起来的文字里，空白折叠、去掉截断省略号后比对，英文数字的两端
 * 要落在词边界上），并且没有被折叠、截掉的部分（同一操作重复多次的计数、超出上限未列出的操作或调用）。
 *
 * 抬头的工具名与耗时不计：行上本来就有。归并行里逐次调用的耗时也不计：只多出几个耗时不值得弹气泡。
 * 行内文字被 CSS 截断时，由 CompactToolRow 在没有详情的情况下弹出全文，这里只看文字有没有重复。
 */
export function doesToolCallHoverAddToRow(hover: ToolCallHover, row: ToolCallHoverRowText): boolean {
  const rowText = normalizeInline(
    [row.label, row.detail, row.status].filter((part) => isNonBlankString(part)).join(' ')
  )
  const isNew = (text: LooseOptional<string>): boolean => !isShownOnRow(text, rowText)

  if (hover.kind === 'merged')
    return (
      hover.hiddenCallCount > 0 ||
      hover.calls.some(
        (call) =>
          call.hiddenChipCount > 0 ||
          call.chips.some(isNew) ||
          isNew(call.target) ||
          isNew(call.errorText)
      )
    )

  return (
    hover.hiddenOperationCount > 0 ||
    hover.operationRows.some(
      ({ operation, count }) => count > 1 || isNew(operation.id) || isNew(operation.target)
    ) ||
    hover.detailLines.some(isNew) ||
    isNew(hover.summaryText) ||
    isNew(hover.errorText) ||
    isNew(hover.fallbackDescription)
  )
}

function DetailsHeader({
  toolName,
  status,
}: {
  toolName: string
  status: Nullable<string>
}): ReactElement {
  return (
    <div className={styles.header}>
      <span className={styles.toolName}>{toolName}</span>
      {!!status && <span className={styles.status}>{status}</span>}
    </div>
  )
}

function SingleCallDetails({ hover }: { hover: SingleToolCallHover }): ReactElement {
  const { t } = useConversationI18n()

  return (
    <div className={styles.root} data-slot="tool-call-hover-details">
      <DetailsHeader toolName={hover.toolName} status={hover.status} />
      {!isEmpty(hover.operationRows) && (
        <ul className={styles.operationList}>
          {hover.operationRows.map(({ operation, count }, index) => (
            <li key={`${operation.id}:${index}`} className={styles.operationLine}>
              <code className={styles.chip}>{operation.id}</code>
              {/* 没有对象也占住中间一列，计数才能落在第三列。 */}
              <span className={styles.target}>{operation.target}</span>
              {count > 1 && <span className={styles.lineMeta}>×{count}</span>}
            </li>
          ))}
        </ul>
      )}
      {hover.hiddenOperationCount > 0 && (
        <div className={styles.more}>
          {t('toolSummary.hoverMoreOperations', { count: hover.hiddenOperationCount })}
        </div>
      )}
      {hover.detailLines.map((line) => (
        <div key={line} className={cx('detail', hover.codeDetail && 'code')}>
          {line}
        </div>
      ))}
      {!!hover.summaryText && <div className={styles.summary}>{hover.summaryText}</div>}
      {!!hover.errorText && (
        <div className={styles.error} data-tone="error">
          {clampErrorText(hover.errorText)}
        </div>
      )}
      {!!hover.fallbackDescription && <div className={styles.muted}>{hover.fallbackDescription}</div>}
    </div>
  )
}

function MergedCallsDetails({ hover }: { hover: MergedToolCallHover }): ReactElement {
  const { t } = useConversationI18n()
  const status = [t('toolSummary.hoverCallCount', { count: hover.callCount }), hover.groupStatus]
    .filter((part): part is string => isNonBlankString(part))
    .join(' · ')

  return (
    <div className={styles.root} data-slot="tool-call-hover-details">
      <DetailsHeader toolName={hover.toolName} status={status} />
      <ul className={styles.list}>
        {hover.calls.map((call) => (
          <li
            key={call.toolCallId}
            className={cx('call', !!call.errorText && 'callError')}
            data-tone={optionalWhen(!!call.errorText, 'error')}
          >
            <div className={styles.line}>
              {call.chips.map((chip) => (
                <code key={chip} className={styles.chip}>
                  {chip}
                </code>
              ))}
              {call.hiddenChipCount > 0 && (
                <span className={styles.chipOverflow}>+{call.hiddenChipCount}</span>
              )}
              {!!call.target && (
                <span className={cx('target', hover.codeTarget && 'code')}>{call.target}</span>
              )}
              {!!call.statusLabel && <span className={styles.lineMeta}>{call.statusLabel}</span>}
            </div>
            {!!call.errorText && (
              <div className={styles.callErrorMessage}>{clampErrorText(call.errorText)}</div>
            )}
          </li>
        ))}
      </ul>
      {hover.hiddenCallCount > 0 && (
        <div className={styles.more}>{t('toolSummary.hoverMoreCalls', { count: hover.hiddenCallCount })}</div>
      )}
    </div>
  )
}

/** 按已推导好的内容渲染气泡。 */
function ToolCallHoverView({ hover }: { hover: ToolCallHover }): ReactElement {
  return hover.kind === 'merged' ? <MergedCallsDetails hover={hover} /> : <SingleCallDetails hover={hover} />
}

/**
 * 紧凑工具行的悬停详情内容，交给 `CompactToolRow` 的 `hoverContent`（或归并行的同名字段）。
 * 一个 block 按单次调用展示；多个 block 按归并行逐次调用展示。不判断与行是否重复——
 * 需要「多不出就不弹」时用 `resolveToolCallHoverContent`。
 */
export function ToolCallHoverDetails(props: ToolCallHoverDetailsProps): Nullable<ReactElement> {
  const { locale } = useConversationI18n()
  const runtime = useConversationTranslatorRuntime()
  const hover = describeToolCallHover(props, locale, runtime)

  return hover ? <ToolCallHoverView hover={hover} /> : null
}

/**
 * 给紧凑行挂的悬停详情：气泡比行多出信息（`doesToolCallHoverAddToRow`）时返回气泡内容，
 * 否则返回 undefined——行上看得全就不弹，行文字被截断时 CompactToolRow 自己弹全文。
 */
export function resolveToolCallHoverContent(
  props: ToolCallHoverDetailsProps,
  row: ToolCallHoverRowText,
  locale: AppLocale,
  runtime: ConversationTranslator
): Optional<ReactElement> {
  const hover = describeToolCallHover(props, locale, runtime)
  if (!hover || !doesToolCallHoverAddToRow(hover, row)) return undefined

  return <ToolCallHoverView hover={hover} />
}
