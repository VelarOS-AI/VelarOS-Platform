import {
  memo,
  type ReactElement,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { useEventListener } from 'ahooks'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { useConversationI18n } from '../i18n'
import { useTimerScope } from '../react-hooks/useTimerScope'

import type { FileDiffRow, FileDiffSummary } from './fileChangeDiff'
import {
  type DiffCodeLanguage,
  type DiffCodeTokenKind,
  inferDiffCodeLanguageFromPath,
  tokenizeDiffCodeLine,
} from './fileChangeDiffHighlight'

import styles from './FileChangeSummaryList.module.css'

import type { SystemFileChangePreviewResult } from '#contracts'
import { isEmpty, isPresent, optionalWhenLazy } from '#internal/runtime'
import type { TimerLease } from '#internal/timerScope'

const cx = StyleUtils.bindCx(styles)

const DIFF_ROW_HEIGHT = 21
const DIFF_COLLAPSED_ROW_HEIGHT = 32
const DIFF_SUMMARY_SEPARATOR_HEIGHT = 1
const DIFF_TABLE_FALLBACK_HEIGHT = 420
const DIFF_ROW_OVERSCAN = 8

const DIFF_TABLE_SUPPORTS_RESIZE_OBSERVER = !!globalThis.ResizeObserver
const DIFF_TOKEN_CLASS: Partial<Record<DiffCodeTokenKind, string>> = {
  attribute: styles.diffTokenAttribute,
  comment: styles.diffTokenComment,
  function: styles.diffTokenFunction,
  keyword: styles.diffTokenKeyword,
  number: styles.diffTokenNumber,
  operator: styles.diffTokenOperator,
  property: styles.diffTokenProperty,
  punctuation: styles.diffTokenPunctuation,
  string: styles.diffTokenString,
  tag: styles.diffTokenTag,
  type: styles.diffTokenType,
  variable: styles.diffTokenVariable,
}

export interface FileChangeSummaryListEntry {
  key: string
  rootPath?: LooseOptional<string>
  path: string
  added: number
  removed: number
  previews?: SystemFileChangePreviewResult[]
  diffSummaries: FileDiffSummary[]
  changeIds?: string[]
  disabled?: boolean
  actionsDisabled?: boolean
  rolledBack?: boolean
  isToggling?: boolean
  addedLabel?: ReactNode
  removedLabel?: ReactNode
}

interface FileChangeSummaryListProps {
  entries: FileChangeSummaryListEntry[]
  expandedKeys: ReadonlySet<string>
  onToggleEntry: (key: string) => void
  onOpenEntry?: (entry: FileChangeSummaryListEntry) => void
  onToggleEntryChanges?: (entry: FileChangeSummaryListEntry) => void
  formatPathForDisplay?: (path: string) => string
}

type VirtualDiffItem =
  | {
      type: 'separator'
      key: string
    }
  | {
      type: 'collapsed' | 'row'
      key: string
      row: FileDiffRow
    }

type Translate = ReturnType<typeof useConversationI18n>['t']

const DiffCodeText = memo(({ text, language }: { text: string; language: DiffCodeLanguage }): ReactElement => {
  const tokens = useMemo(() => tokenizeDiffCodeLine(text, language), [language, text])

  return (
    <span className={styles.diffText}>
      <span className={styles.diffCode}>
        {tokens.map((token, index) => {
          const tokenClass = DIFF_TOKEN_CLASS[token.kind]
          if (!tokenClass) return token.text

          return (
            <span key={`${index}:${token.kind}`} className={tokenClass}>
              {token.text}
            </span>
          )
        })}
      </span>
    </span>
  )
})

DiffCodeText.displayName = 'FileChangeSummaryDiffCodeText'

function buildVirtualDiffItems(summaries: readonly FileDiffSummary[]): VirtualDiffItem[] {
  const items: VirtualDiffItem[] = []

  for (let summaryIndex = 0; summaryIndex < summaries.length; summaryIndex += 1) {
    const summary = summaries[summaryIndex]
    if (!summary) continue

    if (summaryIndex > 0) {
      items.push({
        type: 'separator',
        key: `separator:${summaryIndex}`,
      })
    }

    for (let rowIndex = 0; rowIndex < summary.rows.length; rowIndex += 1) {
      const row = summary.rows[rowIndex]
      if (!row) continue

      items.push({
        type: row.kind === 'collapsed' ? 'collapsed' : 'row',
        key: `${summaryIndex}:${row.kind}:${rowIndex}`,
        row,
      })
    }
  }

  return items
}

function renderVirtualDiffItem(
  item: VirtualDiffItem,
  t: Translate,
  language: DiffCodeLanguage
): ReactElement {
  if (item.type === 'separator') return <div key={item.key} className={styles.diffSummarySeparator} />

  const { row } = item
  return row.kind === 'collapsed' ? (
    <div key={item.key} className={styles.collapsedRow}>
      {t('chat.fileChangeCollapsed', {
        count: row.hiddenCount ?? 0,
      })}
    </div>
  ) : (
    <div
      key={item.key}
      className={cx(
        'diffRow',
        row.kind === 'add' && 'diffRowAdd',
        row.kind === 'remove' && 'diffRowRemove'
      )}
    >
      <span className={styles.lineNumber}>{row.newLineNumber ?? row.oldLineNumber ?? ''}</span>
      <span className={styles.diffMarker}>
        {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}
      </span>
      <DiffCodeText text={row.text} language={language} />
    </div>
  )
}

function renderVisibleDiffItems(
  items: readonly VirtualDiffItem[],
  startIndex: number,
  endIndex: number,
  t: Translate,
  language: DiffCodeLanguage
): ReactElement[] {
  const renderedItems: ReactElement[] = []

  for (let index = startIndex; index < endIndex; index += 1) {
    const item = items[index]
    if (item) renderedItems.push(renderVirtualDiffItem(item, t, language))
  }

  return renderedItems
}

function isChangedDiffRow(row: FileDiffRow): boolean {
  return row.kind === 'add' || row.kind === 'remove'
}

function trimDiffSummaryToChangedRange(summary: FileDiffSummary): FileDiffSummary {
  const firstChangedIndex = summary.rows.findIndex(isChangedDiffRow)

  if (firstChangedIndex < 0) return summary

  let lastChangedIndex = firstChangedIndex
  for (let index = summary.rows.length - 1; index > firstChangedIndex; index -= 1) {
    const row = summary.rows[index]
    if (isChangedDiffRow(row)) {
      lastChangedIndex = index
      break
    }
  }

  let startIndex = 0
  for (let index = firstChangedIndex - 1; index >= 0; index -= 1) {
    if (summary.rows[index].kind === 'collapsed') {
      startIndex = index + 1
      break
    }
  }

  let endIndex = summary.rows.length
  for (let index = lastChangedIndex + 1; index < summary.rows.length; index += 1) {
    if (summary.rows[index].kind === 'collapsed') {
      endIndex = index
      break
    }
  }

  return {
    ...summary,
    rows: summary.rows.slice(startIndex, endIndex),
  }
}

function getVirtualDiffItemHeight(item: VirtualDiffItem): number {
  if (item.type === 'separator') return DIFF_SUMMARY_SEPARATOR_HEIGHT

  return item.type === 'collapsed' ? DIFF_COLLAPSED_ROW_HEIGHT : DIFF_ROW_HEIGHT
}

function findVisibleItemIndex(offsets: readonly number[], targetOffset: number): number {
  const rowCount = offsets.length - 1
  if (rowCount <= 0) return 0

  if (targetOffset <= 0) return 0

  if (targetOffset >= offsets[rowCount]) return rowCount - 1

  let low = 0
  let high = rowCount - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (offsets[mid + 1] <= targetOffset) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return Math.min(low, rowCount - 1)
}

function DiffTable({
  summaries,
  path,
}: {
  summaries: readonly FileDiffSummary[]
  path: string
}): ReactElement {
  const { t } = useConversationI18n()
  const language = useMemo(() => inferDiffCodeLanguageFromPath(path), [path])
  const tableRef = useRef<HTMLDivElement>(null)
  const timers = useTimerScope('FileChangeSummaryList')
  const scrollFrameRef = useRef<TimerLease>(null)
  const pendingScrollTopRef = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(DIFF_TABLE_FALLBACK_HEIGHT)
  const visibleSummaries = useMemo(
    () => {
      const visible: FileDiffSummary[] = []
      for (const summary of summaries) {
        const trimmed = trimDiffSummaryToChangedRange(summary)
        if (!isEmpty(trimmed.rows)) {
          visible.push(trimmed)
        }
      }

      return visible
    },
    [summaries]
  )
  const items = useMemo(() => buildVirtualDiffItems(visibleSummaries), [visibleSummaries])
  const itemMetrics = useMemo(() => {
    const offsets: number[] = [0]
    items.forEach((item) => {
      offsets.push(offsets[offsets.length - 1] + getVirtualDiffItemHeight(item))
    })

    return {
      offsets,
      totalHeight: offsets[offsets.length - 1],
    }
  }, [items])
  const visibleWindow = useMemo(() => {
    if (isEmpty(items)) return {
        startIndex: 0,
        endIndex: 0,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
      }

    const viewportBottom = scrollTop + Math.max(viewportHeight, 1)
    const firstVisibleIndex = findVisibleItemIndex(itemMetrics.offsets, scrollTop)
    const lastVisibleIndex = findVisibleItemIndex(itemMetrics.offsets, viewportBottom)
    const startIndex = Math.max(0, firstVisibleIndex - DIFF_ROW_OVERSCAN)
    const endIndex = Math.min(items.length, lastVisibleIndex + DIFF_ROW_OVERSCAN + 1)

    return {
      startIndex,
      endIndex,
      topSpacerHeight: itemMetrics.offsets[startIndex],
      bottomSpacerHeight: itemMetrics.totalHeight - itemMetrics.offsets[endIndex],
    }
  }, [itemMetrics.offsets, itemMetrics.totalHeight, items.length, scrollTop, viewportHeight])
  const updateViewportHeight = useCallback(() => {
    const table = tableRef.current
    if (!table) return

    setViewportHeight(table.clientHeight || DIFF_TABLE_FALLBACK_HEIGHT)
  }, [])
  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      pendingScrollTopRef.current = event.currentTarget.scrollTop

      if (isPresent(scrollFrameRef.current)) return

      scrollFrameRef.current = timers.nextFrame(() => {
        scrollFrameRef.current = null
        setScrollTop(pendingScrollTopRef.current)
      })
    },
    [timers]
  )

  useEffect(() => {
    const table = tableRef.current
    if (!table) return undefined

    updateViewportHeight()

    if (!DIFF_TABLE_SUPPORTS_RESIZE_OBSERVER) return undefined

    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(table)

    return () => {
      observer.disconnect()
    }
  }, [updateViewportHeight])

  useEventListener('resize', updateViewportHeight, {
    enable: !DIFF_TABLE_SUPPORTS_RESIZE_OBSERVER,
  })

  useEffect(() => {
    const table = tableRef.current
    if (table) {
      table.scrollTop = 0
    }
    pendingScrollTopRef.current = 0
    setScrollTop(0)
  }, [items])

  useEffect(
    () => () => {
      if (isPresent(scrollFrameRef.current)) {
        scrollFrameRef.current.cancel()
      }
    },
    []
  )

  return (
    <div
      ref={tableRef}
      className={styles.diffTable}
      aria-label="file-change-diff"
      onScroll={handleScroll}
    >
      <div className={styles.diffTableContent}>
        <div
          className={styles.diffVirtualSpacer}
          style={{ height: visibleWindow.topSpacerHeight }}
        />
        {renderVisibleDiffItems(
          items,
          visibleWindow.startIndex,
          visibleWindow.endIndex,
          t,
          language
        )}
        <div
          className={styles.diffVirtualSpacer}
          style={{ height: visibleWindow.bottomSpacerHeight }}
        />
      </div>
    </div>
  )
}

function FileChangeSummaryRow({
  entry,
  expanded,
  onToggle,
  onOpen,
  onToggleChanges,
  formatPathForDisplay,
}: {
  entry: FileChangeSummaryListEntry
  expanded: boolean
  onToggle: () => void
  onOpen?: () => void
  onToggleChanges?: () => void
  formatPathForDisplay?: (path: string) => string
}): ReactElement {
  const { t } = useConversationI18n()
  const displayPath = formatPathForDisplay ? formatPathForDisplay(entry.path) : entry.path
  const disabled = !!entry.disabled
  const canToggleChanges = !!onToggleChanges && (entry.changeIds?.length ?? 0) > 0
  const toggleChangeLabel = entry.rolledBack
    ? t('chat.fileChangeRestore')
    : t('chat.fileChangeUndo')

  return (
    <div className={styles.fileBlock}>
      <div className={styles.fileButton}>
        <Button
          variant="ghost"
          size="block"
          hoverBackground={false}
          className={styles.fileToggleButton}
          aria-expanded={expanded}
          disabled={disabled}
          onClick={onToggle}
        >
          <span className={styles.filePath} title={displayPath}>
            {displayPath}
          </span>
        </Button>
        <span className={styles.fileActions}>
          {!!onToggleChanges && (
            <IconButton
              label={toggleChangeLabel}
              size="icon-sm"
              className={styles.fileActionButton}
              disabled={
                !canToggleChanges || entry.isToggling || entry.actionsDisabled
              }
              onClick={onToggleChanges}
            >
              {entry.isToggling ? (
                <SpinnerGapIcon size={14} className={styles.spinIcon} />
              ) : entry.rolledBack ? (
                <ArrowClockwiseIcon size={14} />
              ) : (
                <ArrowCounterClockwiseIcon size={14} />
              )}
            </IconButton>
          )}
          {onOpen && (
            <IconButton
              label={t('chat.fileChangeOpen')}
              size="icon-sm"
              className={styles.fileActionButton}
              onClick={onOpen}
            >
              <ArrowSquareOutIcon size={14} />
            </IconButton>
          )}
        </span>
        <span className={styles.fileStats} aria-label={`+${entry.added} -${entry.removed}`}>
          <span className={styles.added}>{entry.addedLabel ?? `+${entry.added}`}</span>
          <span className={styles.removed}>{entry.removedLabel ?? `-${entry.removed}`}</span>
        </span>
        <IconButton
          size="icon-sm"
          hoverBackground={false}
          className={styles.fileExpandButton}
          label={expanded ? t('chat.richCollapse') : t('chat.richExpand')}
          aria-expanded={expanded}
          disabled={disabled}
          onClick={onToggle}
        >
          <CaretRightIcon
            size={16}
            weight="bold"
            className={cx('chevron', expanded && 'chevronExpanded')}
            aria-hidden="true"
          />
        </IconButton>
      </div>
      {expanded && (
        <div className={styles.fileBody}>
          <DiffTable summaries={entry.diffSummaries} path={entry.path} />
        </div>
      )}
    </div>
  )
}

export const FileChangeSummaryList = memo(
  ({
    entries,
    expandedKeys,
    onToggleEntry,
    onOpenEntry,
    onToggleEntryChanges,
    formatPathForDisplay,
  }: FileChangeSummaryListProps): ReactElement => (
    <div className={styles.fileList}>
      {entries.map((entry) => (
        <FileChangeSummaryRow
          key={entry.key}
          entry={entry}
          expanded={expandedKeys.has(entry.key)}
          formatPathForDisplay={formatPathForDisplay}
          onToggle={() => onToggleEntry(entry.key)}
          onOpen={optionalWhenLazy(onOpenEntry, () => () => onOpenEntry!(entry))}
          onToggleChanges={optionalWhenLazy(onToggleEntryChanges, () => () => onToggleEntryChanges!(entry))}
        />
      ))}
    </div>
  )
)

FileChangeSummaryList.displayName = 'FileChangeSummaryList'
