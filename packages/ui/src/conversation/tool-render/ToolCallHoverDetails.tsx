/**
 * 工具调用行的悬停详情：这次调用实际执行了哪些操作、作用在什么对象上、结果如何。
 *
 * 单次调用逐项列出操作（一次批量编辑里的每一项），再补完整描述、结果或错误；归并行（×N）按调用
 * 顺序每次调用占一行。它只作为悬停气泡的内容、在气泡打开时才渲染，紧凑行本身不为此做任何推导。
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

interface OperationRow {
  operation: ToolOperationSummary
  count: number
}

interface MergedCallDescription {
  chips: string[]
  hiddenChipCount: number
  target: Nullable<string>
  statusLabel: Nullable<string>
  errorText: Nullable<string>
}

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
function collapseRepeatedOperations(operations: readonly ToolOperationSummary[]): OperationRow[] {
  const rows: OperationRow[] = []
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

function describeMergedCall(
  block: ToolCallBlock,
  formatPathForDisplay: Optional<PathDisplayFormatter>,
  locale: AppLocale,
  runtime: ConversationTranslator
): MergedCallDescription {
  const operations = getToolOperations(block, formatPathForDisplay)
  const operationIds = uniqueStrings(operations.map((operation) => operation.id))
  const targets = uniqueStrings(
    operations.flatMap((operation) => (operation.target ? [operation.target] : []))
  )
  const [firstTarget] = targets
  const operationTarget =
    firstTarget && targets.length > 1 ? `${firstTarget} +${targets.length - 1}` : firstTarget

  return {
    chips: operationIds.slice(0, MaxChipsPerCall),
    hiddenChipCount: Math.max(0, operationIds.length - MaxChipsPerCall),
    target: operationTarget ?? getToolDetailSummary(block, formatPathForDisplay, locale, runtime),
    statusLabel: getToolStatusLabel(block, locale, runtime),
    errorText: readToolErrorText(block),
  }
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

function SingleCallDetails({
  block,
  formatPathForDisplay,
  detail,
  summary,
}: {
  block: ToolCallBlock
  formatPathForDisplay: Optional<PathDisplayFormatter>
  detail: Optional<string | readonly string[]>
  summary: Optional<string>
}): ReactElement {
  const { locale, t } = useConversationI18n()
  const runtime = useConversationTranslatorRuntime()
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
  const operationRows = collapseRepeatedOperations(operations)
  const visibleRows = operationRows.slice(0, MaxListedOperations)
  const hiddenOperationCount =
    operations.length - visibleRows.reduce((total, row) => total + row.count, 0)
  const hasBody = !isEmpty(operations) || !isEmpty(detailLines) || !!summaryText || !!errorText
  // 什么都推不出时退回工具自身的说明，至少让人知道这是个什么工具。
  const fallbackDescription = hasBody
    ? null
    : getToolDescriptionText(block.toolName, locale, undefined, runtime)
  const codeDetail = isCommandToolName(block.toolName)

  return (
    <div className={styles.root} data-slot="tool-call-hover-details">
      <DetailsHeader toolName={block.toolName} status={getToolStatusLabel(block, locale, runtime)} />
      {!isEmpty(visibleRows) && (
        <ul className={styles.operationList}>
          {visibleRows.map(({ operation, count }, index) => (
            <li key={`${operation.id}:${index}`} className={styles.operationLine}>
              <code className={styles.chip}>{operation.id}</code>
              {/* 没有对象也占住中间一列，计数才能落在第三列。 */}
              <span className={styles.target}>{operation.target}</span>
              {count > 1 && <span className={styles.lineMeta}>×{count}</span>}
            </li>
          ))}
        </ul>
      )}
      {hiddenOperationCount > 0 && (
        <div className={styles.more}>
          {t('toolSummary.hoverMoreOperations', { count: hiddenOperationCount })}
        </div>
      )}
      {detailLines.map((line) => (
        <div key={line} className={cx('detail', codeDetail && 'code')}>
          {line}
        </div>
      ))}
      {!!summaryText && <div className={styles.summary}>{summaryText}</div>}
      {!!errorText && (
        <div className={styles.error} data-tone="error">
          {clampErrorText(errorText)}
        </div>
      )}
      {!!fallbackDescription && <div className={styles.muted}>{fallbackDescription}</div>}
    </div>
  )
}

function MergedCallsDetails({
  toolName,
  blocks,
  formatPathForDisplay,
}: {
  toolName: string
  blocks: readonly ToolCallBlock[]
  formatPathForDisplay: Optional<PathDisplayFormatter>
}): ReactElement {
  const { locale, t } = useConversationI18n()
  const runtime = useConversationTranslatorRuntime()
  const visibleBlocks = blocks.slice(0, MaxListedCalls)
  const hiddenCallCount = blocks.length - visibleBlocks.length
  const codeTarget = isCommandToolName(toolName)
  const status = [
    t('toolSummary.hoverCallCount', { count: blocks.length }),
    getToolGroupStatusLabel([...blocks], locale, runtime),
  ]
    .filter((part): part is string => isNonBlankString(part))
    .join(' · ')

  return (
    <div className={styles.root} data-slot="tool-call-hover-details">
      <DetailsHeader toolName={toolName} status={status} />
      <ul className={styles.list}>
        {visibleBlocks.map((block) => {
          const call = describeMergedCall(block, formatPathForDisplay, locale, runtime)
          return (
            <li
              key={block.toolCallId}
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
                  <span className={cx('target', codeTarget && 'code')}>{call.target}</span>
                )}
                {!!call.statusLabel && <span className={styles.lineMeta}>{call.statusLabel}</span>}
              </div>
              {!!call.errorText && (
                <div className={styles.callErrorMessage}>{clampErrorText(call.errorText)}</div>
              )}
            </li>
          )
        })}
      </ul>
      {hiddenCallCount > 0 && (
        <div className={styles.more}>{t('toolSummary.hoverMoreCalls', { count: hiddenCallCount })}</div>
      )}
    </div>
  )
}

/**
 * 紧凑工具行的悬停详情内容，交给 `CompactToolRow` 的 `hoverContent`（或归并行的同名字段）。
 * 一个 block 按单次调用展示；多个 block 按归并行逐次调用展示。
 */
export function ToolCallHoverDetails({
  blocks,
  formatPathForDisplay,
  detail,
  summary,
}: ToolCallHoverDetailsProps): Nullable<ReactElement> {
  const [firstBlock] = blocks
  if (!firstBlock) return null

  // 归并按工具名分组，成员工具名一致，取首个即可。
  if (blocks.length > 1)
    return (
      <MergedCallsDetails
        toolName={firstBlock.toolName}
        blocks={blocks}
        formatPathForDisplay={formatPathForDisplay}
      />
    )

  return (
    <SingleCallDetails
      block={firstBlock}
      formatPathForDisplay={formatPathForDisplay}
      detail={detail}
      summary={summary}
    />
  )
}
