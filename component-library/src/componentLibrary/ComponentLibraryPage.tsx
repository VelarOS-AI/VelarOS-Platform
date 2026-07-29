/**
 * 组件库独立网页入口页面；registry 与示例都由本仓自持。
 * 通过 `bun run dev` 打开，不在 Electron 主应用侧栏中注册。
 */
import { memo, type ReactElement, useMemo, useState } from 'react'
import { toNullable } from '@catalog/catalogPrimitives'
import { useI18n } from '@catalog/i18n'
import { getLocalizedComponentLibrarySections } from '@catalog/models/componentLibraryLocalization'
import { ComponentDocument } from '@catalog/page/ComponentDocument'
import { ComponentLibraryNav } from '@catalog/page/ComponentLibraryNav'
import {
  flattenSections,
  getVisibleSections,
} from '@catalog/page/componentLibrarySearch'
import { componentLibrarySections } from '@catalog/registry/LibraryRegistry'

import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

const ComponentLibraryPage = memo((): ReactElement => {
  const { locale, t } = useI18n()
  const [query, setQuery] = useState('')
  const [selectedEntryId, setSelectedEntryId] = useState<Nullable<string>>(
    (toNullable(componentLibrarySections[0]?.entries[0]?.id))
  )
  const localizedSections = useMemo(
    () => getLocalizedComponentLibrarySections(componentLibrarySections, locale, t),
    [locale, t]
  )
  const normalizedQuery = query.trim().toLowerCase()
  const visibleSections = useMemo(
    () => getVisibleSections({ normalizedQuery, sections: localizedSections, t }),
    [localizedSections, normalizedQuery, t]
  )
  const visibleListEntries = useMemo(() => flattenSections(visibleSections), [visibleSections])
  const selectedListEntry =
    visibleListEntries.find(({ entry }) => entry.id === selectedEntryId) ?? visibleListEntries[0]
  const selectedId = (toNullable(selectedListEntry?.entry.id))

  return (
    <main className={styles.root}>
      <div className={styles.shell}>
        <aside className={styles.indexPane}>
          <Stack gap="md">
            <Stack gap="sm" className={styles.libraryHeader}>
              <Title level={1}>{t('componentLibrary.title')}</Title>
              <Paragraph tone="secondary" spacing="none">
                {t('componentLibrary.overviewCopy')}
              </Paragraph>
            </Stack>

            <Stack
              className={styles.filterPanel}
              gap="sm"
              aria-label={t('componentLibrary.filtersAriaLabel')}
            >
              <Input
                value={query}
                size="sm"
                placeholder={t('componentLibrary.searchPlaceholder')}
                aria-label={t('componentLibrary.searchAriaLabel')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Stack>

            <ComponentLibraryNav
              sections={visibleSections}
              selectedEntryId={selectedId}
              onSelectEntry={setSelectedEntryId}
              t={t}
            />
          </Stack>
        </aside>

        <div className={styles.contentPane}>
          {selectedListEntry ? (
            <div className={styles.docLayout}>
              <ComponentDocument listEntry={selectedListEntry} t={t} />
            </div>
          ) : (
            <div className={styles.emptyResults}>{t('componentLibrary.noMatchingComponents')}</div>
          )}
        </div>
      </div>
    </main>
  )
})

ComponentLibraryPage.displayName = 'ComponentLibraryPage'

export default ComponentLibraryPage
