/**
 * 业务数据表（DataTable 的产品级封装）。
 */
import { type ReactElement } from 'react'

import { DataTable, type DataTableProps } from '@velaros-ai/ui/primitives/layout/DataTable'

/**
 * 设置页和业务列表默认使用无边框表格外观。
 * 设置与检查流程优先使用这个封装，便于集中维护视觉更新。
 */
export function BusinessDataTable<T>(props: DataTableProps<T>): ReactElement {
  const { borderless = true, ...rest } = props
  return <DataTable borderless={borderless} {...rest} />
}

BusinessDataTable.displayName = 'BusinessDataTable'
