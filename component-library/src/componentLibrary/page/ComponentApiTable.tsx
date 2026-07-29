import { memo, type ReactElement } from 'react'

import { resolveComponentLibraryEntryDisplayName } from '../models/componentLibraryLocalization'
import type { ComponentLibraryEntry } from '../models/componentLibraryTypes'

import { getDefaultApiRows } from './componentLibraryApiRows'
import type { ComponentLibraryTranslate } from './componentLibraryPageTypes'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

interface ComponentApiTableProps {
  entry: ComponentLibraryEntry
  t: ComponentLibraryTranslate
}

export const ComponentApiTable = memo(function ComponentApiTable({
  entry,
  t,
}: ComponentApiTableProps): ReactElement {
  const rows = getDefaultApiRows(entry, t)
  const entryDisplayLabel = resolveComponentLibraryEntryDisplayName(t, entry.id, entry.name)

  return (
    <div
      className={styles.apiTable}
      aria-label={t('componentLibrary.propsAriaLabel', { name: entryDisplayLabel })}
    >
      <div className={styles.apiHeader}>
        <span>{t('componentLibrary.apiProperty')}</span>
        <span>{t('componentLibrary.apiDescription')}</span>
        <span>{t('componentLibrary.apiType')}</span>
        <span>{t('componentLibrary.apiDefault')}</span>
        <span>{t('componentLibrary.apiRecommended')}</span>
      </div>
      {rows.map((row) => (
        <div key={row.name} className={styles.apiRow}>
          <code>{row.name}</code>
          <span>{row.description}</span>
          <code>{row.type}</code>
          <code>{row.defaultValue ?? '-'}</code>
          <code>{row.recommended ?? '-'}</code>
        </div>
      ))}
    </div>
  )
})

ComponentApiTable.displayName = 'ComponentApiTable'
