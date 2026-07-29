import { type ReactElement, useMemo, useState } from 'react'
import { useI18n } from '@catalog/i18n'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { type DataTableColumn, type DataTablePaginationConfig } from '@velaros-ai/ui/primitives/layout/DataTable'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { BusinessDataTable } from '@velaros-ai/ui/product/layout/BusinessDataTable'

interface DataTableDemoRow {
  id: string
  title: string
  subtitle: string
  role: string
  updated: string
  sortTs: number
}

export function DataTableExamples(): ReactElement {
  const { t, locale } = useI18n()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(2)
  const rows = useMemo<DataTableDemoRow[]>(
    () => [
      {
        id: '1',
        title: t('componentLibrary.dataTableExample.row1Title'),
        subtitle: t('componentLibrary.dataTableExample.row1Subtitle'),
        role: t('componentLibrary.dataTableExample.row1Role'),
        updated: t('componentLibrary.dataTableExample.row1Updated'),
        sortTs: 1_717_766_400_000,
      },
      {
        id: '2',
        title: t('componentLibrary.dataTableExample.row2Title'),
        subtitle: t('componentLibrary.dataTableExample.row2Subtitle'),
        role: t('componentLibrary.dataTableExample.row2Role'),
        updated: t('componentLibrary.dataTableExample.row2Updated'),
        sortTs: 1_717_680_000_000,
      },
      {
        id: '3',
        title: t('componentLibrary.dataTableExample.row3Title'),
        subtitle: t('componentLibrary.dataTableExample.row3Subtitle'),
        role: t('componentLibrary.dataTableExample.row3Role'),
        updated: t('componentLibrary.dataTableExample.row3Updated'),
        sortTs: 1_717_593_600_000,
      },
    ],
    [t]
  )

  const pagination = useMemo((): DataTablePaginationConfig => {
    const total = rows.length
    const safePageSize = Math.max(1, pageSize)
    const pageCount = Math.max(1, Math.ceil(total / safePageSize))
    const safePage = Math.min(Math.max(1, page), pageCount)
    const from = total === 0 ? 0 : (safePage - 1) * safePageSize + 1
    const to = total === 0 ? 0 : Math.min(safePage * safePageSize, total)
    return {
      page,
      pageSize: safePageSize,
      onPageChange: setPage,
      onPageSizeChange: (next) => {
        setPageSize(next)
        setPage(1)
      },
      pageSizeOptions: [2, 5, 10],
      summaryText: t('componentLibrary.dataTableExample.pageSummary', { from, to, total }),
      previousPageLabel: t('componentLibrary.dataTableExample.previousPageLabel'),
      nextPageLabel: t('componentLibrary.dataTableExample.nextPageLabel'),
      pageSizeLabel: t('componentLibrary.dataTableExample.pageSizeLabel'),
    }
  }, [t, page, pageSize, rows])

  const columns = useMemo<Array<DataTableColumn<DataTableDemoRow>>>(
    () => [
      {
        key: 'primary',
        title: t('componentLibrary.dataTableExample.colRecord'),
        minWidth: 200,
        ellipsis: true,
        sortable: true,
        sorter: (a, b) => a.title.localeCompare(b.title, locale, { sensitivity: 'base' }),
        render: (r) => (
          <Stack gap="xs" className="min-w-0">
            <Text tone="strong" className="[overflow-wrap:anywhere]">
              {r.title}
            </Text>
            <Text tone="caption" className="[overflow-wrap:anywhere]">
              {r.subtitle}
            </Text>
          </Stack>
        ),
      },
      {
        key: 'role',
        title: t('componentLibrary.dataTableExample.colKind'),
        width: 96,
        render: (r) => r.role,
      },
      {
        key: 'updated',
        title: t('componentLibrary.dataTableExample.colUpdated'),
        width: 132,
        align: 'right',
        sortable: true,
        defaultSortOrder: 'desc',
        sorter: (a, b) => a.sortTs - b.sortTs,
        render: (r) => r.updated,
      },
    ],
    [t, locale]
  )

  return (
    <Stack gap="xs" className="min-w-0">
      <Text tone="caption">{t('componentLibrary.dataTableExample.leadCaption')}</Text>
      <div className="min-w-0">
        <BusinessDataTable
          borderless
          columns={columns}
          data={rows}
          getRowKey={(r) => r.id}
          selectedRowKey="2"
          onRowClick={() => undefined}
          size="sm"
          defaultSort={{ columnKey: 'primary', order: 'asc' }}
          pagination={pagination}
        />
      </div>
    </Stack>
  )
}

export const dataTableRecommendations = [
  {
    id: 'settings-business-data-table',
    title: 'Settings lists compose BusinessDataTable',
    description:
      'Settings screens are not a second table primitive: SkillManagementPanel wraps BusinessDataTable with borderless chrome, optional headerSlot toolbars, sortable columns, row actions, and client-side pagination.',
    code: `// Pattern: settings inventory (see SkillManagementPanel.tsx)
<BusinessDataTable
  borderless
  columns={columns}
  data={rows}
  headerSlot={<ListToolbar />}
  pagination={tablePagination}
/>`,
  },
]
