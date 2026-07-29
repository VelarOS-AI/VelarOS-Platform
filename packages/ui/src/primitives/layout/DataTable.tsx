/**
 * 数据表格原语，列定义驱动。
 *
 * 样式：`.velar-data-table-pagination-bar` · 见 styles/components/。
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useMemo,
  useState,
} from 'react'
import { CaretLeftIcon, CaretRightIcon, TableIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'

import { useUiLocalization } from '../../i18n/UiLocalizationProvider'
import { cn } from '../../lib/cn'
import { isEmpty, isFalse,isNumber, isPresent, optionalWhen, optionalWhenLazy, toNullable } from '../../lib/runtime'
/**
 * 带项目样式的语义化表格。
 * 交互行基于原生表格行与单元格组合。
 * 可通过列排序配置启用客户端排序，表头会渲染排序按钮。
 */
export type DataTableSortOrder = 'asc' | 'desc'

export interface DataTableSortState {
  columnKey: string
  order: DataTableSortOrder
}

export interface DataTableColumn<T> {
  key: string
  title: ReactNode
  width?: number | string
  minWidth?: number | string
  align?: 'left' | 'center' | 'right'
  ellipsis?: boolean
  headerClassName?: string
  cellClassName?: string
  sortable?: boolean
  sorter?: (a: T, b: T) => number
  defaultSortOrder?: DataTableSortOrder
  render: (record: T, rowIndex: number) => ReactNode
}

/** 客户端分页：先对完整数据排序，再展示当前页。 */
export interface DataTablePaginationConfig {
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: readonly number[]
  /** 当前分页片段的本地化摘要；省略时隐藏左侧分页说明。 */
  summaryText?: string
  previousPageLabel: string
  nextPageLabel: string
  pageSizeLabel?: string
}

/** 传给选择列表头渲染器，用于构造自定义选择列表头。 */
export interface DataTableSelectionHeaderApi {
  allPageSelected: boolean
  somePageSelected: boolean
  disabled: boolean
  loading: boolean
  visibleRowCount: number
  /** 在当前页全选与当前页全不选之间切换。 */
  togglePageSelection: () => void
  selectAllAriaLabel?: string
}

/** 表格行选择：复选框加表头当前页全选。 */
export interface DataTableRowSelection<T> {
  selectedRowKeys: readonly string[]
  onChange: (nextKeys: string[]) => void
  getCheckboxProps?: (record: T, rowIndex: number) => { disabled?: boolean }
  /** 省略时选择列按内容自适应；传数字时作为固定像素列宽。 */
  columnWidth?: number
  /** 表头“选择当前页”控件的无障碍标签。 */
  selectAllAriaLabel?: string
  /** 设置后替换默认表头复选框，例如筛选菜单加选择当前页。 */
  renderSelectionHeader?: (api: DataTableSelectionHeaderApi) => ReactNode
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>
  data: readonly T[]
  getRowKey: (record: T, rowIndex: number) => string
  emptySlot?: ReactNode
  /**
   * 空状态前置视觉元素。省略时使用默认表格图标；传空值可隐藏，适合完全自定义空状态。
   */
  emptyIcon?: LooseOptional<ReactNode>
  loading?: boolean
  loadingSlot?: ReactNode
  size?: 'sm' | 'md'
  striped?: boolean
  /** 移除外框和单元格边框，适合记忆列表这类扁平表格。 */
  borderless?: boolean
  className?: string
  tableClassName?: string
  selectedRowKey?: LooseOptional<string>
  onRowClick?: (record: T, rowIndex: number) => void
  /** 初始客户端排序；用户仍可通过可排序表头切换。 */
  defaultSort?: LooseOptional<DataTableSortState>
  /** 渲染在表头上方的工具栏或标题行；吸顶表头仍停留在表格块内。 */
  headerSlot?: ReactNode
  /** 内置分页上方的额外页脚。 */
  footerSlot?: ReactNode
  pagination?: DataTablePaginationConfig
  rowSelection?: DataTableRowSelection<T>
  /** 表格主体上方的全宽工具条，例如列筛选。 */
  tableToolbar?: ReactNode
  /**
   * 为真时，表格填满弹性父容器剩余高度，且只有表格主体区域纵向滚动。
   * 表头会在滚动区域内保持吸顶。
   */
  scrollableBody?: boolean
  /**
   * 限制表格块高度，可传像素数字或样式长度。
   * 与主体滚动组合时由内部主体滚动；否则在表格包裹层产生纵向溢出。
   */
  bodyMaxHeight?: number | string
}

function colStyle(width?: number | string, minWidth?: number | string) {
  const style: CSSProperties = {}
  if (isPresent(width)) {
    style.width = isNumber(width) ? `${width}px` : width
  }
  if (isPresent(minWidth)) {
    style.minWidth = isNumber(minWidth) ? `${minWidth}px` : minWidth
  }
  return optionalWhen(!isEmpty(Object.keys(style)), style)
}

function applySort<T>(
  rows: readonly T[],
  columns: Array<DataTableColumn<T>>,
  sortState: Nullable<DataTableSortState>
): T[] {
  if (!sortState) return [...rows]

  const column = columns.find((item) => item.key === sortState.columnKey)
  if (!column?.sortable || !column.sorter) return [...rows]

  const direction = sortState.order === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => direction * column.sorter!(a, b))
}

function DataTablePaginationBar({
  config,
  rowCount,
}: {
  config: DataTablePaginationConfig
  rowCount: number
}): Nullable<ReactElement> {
  if (rowCount === 0) return null

  const {
    page,
    pageSize,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions = [10, 20, 50],
    summaryText,
    previousPageLabel,
    nextPageLabel,
    pageSizeLabel,
  } = config

  const pageCount = Math.max(1, Math.ceil(rowCount / pageSize))
  const effectivePage = Math.min(Math.max(1, page), pageCount)

  const mergedSizes = [...new Set([...pageSizeOptions, pageSize])].sort((a, b) => a - b)
  const sizeOptions = mergedSizes.map((n) => ({
    value: String(n),
    label: String(n),
  }))

  return (
    <div
      className={cn(
        'velar-data-table-pagination-bar',
        !summaryText && 'velar-data-table-pagination-bar-no-summary'
      )}
    >
      {!!summaryText && <p className={'velar-data-table-pagination-summary'}>{summaryText}</p>}
      <div className={'velar-data-table-pagination-controls'}>
        {!!(onPageSizeChange && pageSizeLabel) && (
          <label className={'velar-data-table-page-size-field'}>
            <span className={'velar-data-table-page-size-label'}>{pageSizeLabel}</span>
            <Select
              size="sm"
              variant="bare"
              value={String(pageSize)}
              options={sizeOptions}
              onChange={(value) => onPageSizeChange(+value)}
            />
          </label>
        )}
        <div className={'velar-data-table-pagination-nav'}>
          <Button
            size="icon-sm"
            variant="ghost"
            className={'velar-data-table-pagination-icon-btn'}
            disabled={effectivePage <= 1}
            aria-label={previousPageLabel}
            title={previousPageLabel}
            onClick={() => onPageChange(effectivePage - 1)}
          >
            <CaretLeftIcon size={14} weight="bold" aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className={'velar-data-table-pagination-icon-btn'}
            disabled={effectivePage >= pageCount}
            aria-label={nextPageLabel}
            title={nextPageLabel}
            onClick={() => onPageChange(effectivePage + 1)}
          >
            <CaretRightIcon size={14} weight="bold" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}

function DataTableInner<T>({
  columns,
  data,
  getRowKey,
  emptySlot,
  emptyIcon,
  loading,
  loadingSlot,
  size = 'md',
  striped,
  borderless = false,
  className,
  tableClassName,
  selectedRowKey,
  onRowClick,
  defaultSort = null,
  headerSlot,
  footerSlot,
  pagination,
  tableToolbar,
  scrollableBody = false,
  bodyMaxHeight,
  rowSelection,
}: DataTableProps<T>): ReactElement {
  const localization = useUiLocalization()
  const hasSelection = !!rowSelection
  const selectionFit = !!(rowSelection && !isPresent(rowSelection.columnWidth))
  const selectionColWidth = rowSelection?.columnWidth ?? 36
  const selectionNarrow = !selectionFit && selectionColWidth <= 32
  const colCount = columns.length + (hasSelection ? 1 : 0)
  const interactive = !!onRowClick
  const [sortState, setSortState] = useState<Nullable<DataTableSortState>>(() =>
    toNullable(defaultSort)
  )

  const sortedData = useMemo(() => applySort(data, columns, sortState), [columns, data, sortState])

  const { visibleRows, rowCount } = useMemo(() => {
    const rowCountInner = sortedData.length
    if (!pagination || loading) return { visibleRows: sortedData, rowCount: rowCountInner }
    const pageSize = Math.max(1, pagination.pageSize)
    const pageCount = Math.max(1, Math.ceil(rowCountInner / pageSize))
    const effectivePage = Math.min(Math.max(1, pagination.page), pageCount)
    const start = (effectivePage - 1) * pageSize
    return {
      visibleRows: sortedData.slice(start, start + pageSize),
      rowCount: rowCountInner,
    }
  }, [loading, pagination, sortedData])

  const selectionKeySet = useMemo(
    () => new Set(rowSelection?.selectedRowKeys ?? []),
    [rowSelection?.selectedRowKeys]
  )

  const pageRowKeys = useMemo(
    () => visibleRows.map((record, index) => getRowKey(record, index)),
    [getRowKey, visibleRows]
  )

  const allPageSelected =
    hasSelection && visibleRows.length > 0 && pageRowKeys.every((key) => selectionKeySet.has(key))
  const somePageSelected = hasSelection && pageRowKeys.some((key) => selectionKeySet.has(key))

  const togglePageSelection = (): void => {
    if (!rowSelection) return
    const prev = [...rowSelection.selectedRowKeys]
    if (allPageSelected) {
      rowSelection.onChange(prev.filter((key) => !pageRowKeys.includes(key)))
      return
    }
    rowSelection.onChange([...new Set([...prev, ...pageRowKeys])])
  }

  const toggleRowSelection = (record: T, rowIndex: number): void => {
    if (!rowSelection) return
    const key = getRowKey(record, rowIndex)
    const prev = [...rowSelection.selectedRowKeys]
    if (selectionKeySet.has(key)) {
      rowSelection.onChange(prev.filter((item) => item !== key))
    } else {
      rowSelection.onChange([...prev, key])
    }
  }

  const handleHeaderSortClick = (column: DataTableColumn<T>): void => {
    if (!column.sortable || !column.sorter || loading) return

    if (sortState?.columnKey === column.key) {
      setSortState({
        columnKey: column.key,
        order: sortState.order === 'asc' ? 'desc' : 'asc',
      })
      return
    }

    setSortState({
      columnKey: column.key,
      order: column.defaultSortOrder ?? 'asc',
    })
  }

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    record: T,
    index: number
  ) => {
    if (!onRowClick) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onRowClick(record, index)
    }
  }

  const headerAriaSort = (column: DataTableColumn<T>): 'ascending' | 'descending' | 'none' => {
    if (!column.sortable || sortState?.columnKey !== column.key) return 'none'

    return sortState.order === 'asc' ? 'ascending' : 'descending'
  }

  const showFooter = !!(footerSlot ?? (pagination && !loading))

  const tableScrollStyle = useMemo(() => {
    if (!isPresent(bodyMaxHeight)) return undefined

    return {
      maxHeight: isNumber(bodyMaxHeight) ? `${bodyMaxHeight}px` : bodyMaxHeight,
      minHeight: 0,
    }
  }, [bodyMaxHeight])

  return (
    <div
      data-slot="data-table"
      className={cn(
        'velar-data-table',
        size === 'sm' && 'velar-data-table-size-sm',
        scrollableBody && 'velar-data-table-root-scroll-body',
        borderless && 'velar-data-table-root-borderless',
        className
      )}
    >
      {!!headerSlot && <div className={'velar-data-table-header-slot'}>{headerSlot}</div>}

      {!!tableToolbar && <div className={'velar-data-table-table-toolbar'}>{tableToolbar}</div>}

      <div
        className={cn(
          'velar-data-table-table-scroll',
          scrollableBody && 'velar-data-table-table-scroll-scroll-body',
          isPresent(bodyMaxHeight) && !scrollableBody && 'velar-data-table-table-scroll-capped'
        )}
        style={tableScrollStyle}
      >
        <table className={cn('velar-data-table-table', tableClassName)}>
          <colgroup>
            {hasSelection && (
              <col
                key="__selection__"
                className={optionalWhenLazy(
                  selectionFit,
                  () => 'velar-data-table-col-selection-fit'
                )}
                style={optionalWhenLazy(!selectionFit, () =>
                  colStyle(selectionColWidth, selectionColWidth)
                )}
              />
            )}
            {columns.map((column) => (
              <col key={column.key} style={colStyle(column.width, column.minWidth)} />
            ))}
          </colgroup>
          <thead className={'velar-data-table-thead'}>
            <tr>
              {hasSelection && (
                <th
                  key="__selection__"
                  scope="col"
                  className={cn(
                    'velar-data-table-th',
                    selectionFit
                      ? 'velar-data-table-th-selection-fit'
                      : 'velar-data-table-th-selection',
                    !selectionFit && selectionNarrow && 'velar-data-table-th-selection-narrow'
                  )}
                  style={optionalWhenLazy(!selectionFit, () =>
                    colStyle(selectionColWidth, selectionColWidth)
                  )}
                >
                  {rowSelection?.renderSelectionHeader ? (
                    rowSelection.renderSelectionHeader({
                      allPageSelected,
                      somePageSelected,
                      disabled: !!loading || visibleRows.length === 0,
                      loading: !!loading,
                      visibleRowCount: visibleRows.length,
                      togglePageSelection,
                      selectAllAriaLabel: rowSelection.selectAllAriaLabel,
                    })
                  ) : (
                    <Checkbox
                      size="sm"
                      checked={allPageSelected}
                      indeterminate={somePageSelected && !allPageSelected}
                      disabled={loading || visibleRows.length === 0}
                      aria-label={rowSelection?.selectAllAriaLabel ?? localization.selectAllOnPage}
                      onCheckedChange={() => togglePageSelection()}
                    />
                  )}
                </th>
              )}
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  style={colStyle(column.width, column.minWidth)}
                  aria-sort={optionalWhenLazy(column.sortable, () => headerAriaSort(column))}
                  className={cn(
                    'velar-data-table-th',
                    column.align === 'center' && 'velar-data-table-th-center',
                    column.align === 'right' && 'velar-data-table-th-right',
                    column.sortable && 'velar-data-table-th-sortable',
                    column.headerClassName
                  )}
                >
                  {column.sortable && column.sorter ? (
                    <button
                      type="button"
                      className={'velar-data-table-sort-button'}
                      disabled={loading}
                      onClick={() => handleHeaderSortClick(column)}
                    >
                      <span className={'velar-data-table-sort-button-label'}>{column.title}</span>
                      <span className={'velar-data-table-sort-icons'} aria-hidden>
                        <span
                          className={cn(
                            'velar-data-table-sort-caret',
                            sortState?.columnKey === column.key &&
                              sortState.order === 'asc' &&
                              'velar-data-table-sort-caret-active'
                          )}
                        >
                          ▲
                        </span>
                        <span
                          className={cn(
                            'velar-data-table-sort-caret',
                            sortState?.columnKey === column.key &&
                              sortState.order === 'desc' &&
                              'velar-data-table-sort-caret-active'
                          )}
                        >
                          ▼
                        </span>
                      </span>
                    </button>
                  ) : (
                    column.title
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className={cn('velar-data-table-tbody', striped && 'velar-data-table-tbody-striped')}
          >
            {loading ? (
              <tr className={'velar-data-table-loading-row'}>
                <td colSpan={colCount} className={'velar-data-table-loading-cell'}>
                  {loadingSlot ?? '…'}
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr className={'velar-data-table-empty-row'}>
                <td colSpan={colCount} className={'velar-data-table-empty-cell'}>
                  {isPresent(emptyIcon) ? (
                    <div className={'velar-data-table-empty-state'}>
                      {emptyIcon ?? (
                        <TableIcon
                          size={40}
                          strokeWidth={1.15}
                          className={'velar-data-table-empty-icon'}
                          aria-hidden
                        />
                      )}
                      {isPresent(emptySlot) && !isFalse(emptySlot) && (
                        <div className={'velar-data-table-empty-slot-wrap'}>{emptySlot}</div>
                      )}
                    </div>
                  ) : (
                    emptySlot
                  )}
                </td>
              </tr>
            ) : (
              visibleRows.map((record, rowIndex) => {
                const rowKey = getRowKey(record, rowIndex)
                const selected = isPresent(selectedRowKey) && selectedRowKey === rowKey
                const batchSelected = hasSelection && selectionKeySet.has(rowKey)
                const checkboxProps = rowSelection?.getCheckboxProps?.(record, rowIndex) ?? {}

                return (
                  <tr
                    key={rowKey}
                    data-selected={selected}
                    data-batch-selected={batchSelected}
                    className={cn(
                      'velar-data-table-tr',
                      interactive && 'velar-data-table-tr-interactive'
                    )}
                    tabIndex={optionalWhenLazy(interactive, () => 0)}
                    aria-selected={optionalWhen(interactive, selected)}
                    onClick={optionalWhen(interactive, () => onRowClick?.(record, rowIndex))}
                    onKeyDown={optionalWhenLazy(
                      interactive,
                      () => (event) => handleRowKeyDown(event, record, rowIndex)
                    )}
                  >
                    {hasSelection && (
                      <td
                        key="__selection__"
                        className={cn(
                          'velar-data-table-td',
                          selectionFit
                            ? 'velar-data-table-td-selection-fit'
                            : 'velar-data-table-td-selection',
                          !selectionFit && selectionNarrow && 'velar-data-table-td-selection-narrow'
                        )}
                        style={optionalWhenLazy(!selectionFit, () =>
                          colStyle(selectionColWidth, selectionColWidth)
                        )}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          size="sm"
                          checked={selectionKeySet.has(rowKey)}
                          disabled={loading || checkboxProps.disabled}
                          aria-label={localization.selectRow}
                          onCheckedChange={() => toggleRowSelection(record, rowIndex)}
                        />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'velar-data-table-td',
                          column.align === 'center' && 'velar-data-table-td-center',
                          column.align === 'right' && 'velar-data-table-td-right',
                          column.ellipsis && 'velar-data-table-td-ellipsis',
                          column.cellClassName
                        )}
                      >
                        {column.render(record, rowIndex)}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {showFooter && (
        <div className={'velar-data-table-footer-bar'}>
          <div
            className={cn(
              'velar-data-table-footer-row',
              !footerSlot &&
                pagination &&
                !loading &&
                'velar-data-table-footer-row-pagination-only',
              footerSlot && !(pagination && !loading) && 'velar-data-table-footer-row-leading-only'
            )}
          >
            {!!footerSlot && <div className={'velar-data-table-footer-leading'}>{footerSlot}</div>}
            {!!(pagination && !loading) && (
              <div className={'velar-data-table-footer-pagination'}>
                <DataTablePaginationBar config={pagination} rowCount={rowCount} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function DataTable<T>(props: DataTableProps<T>): ReactElement {
  return <DataTableInner {...props} />
}
