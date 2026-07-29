import { memo, type ReactElement } from 'react'

import { CollapsibleNav } from '@velaros-ai/ui/product/layout/CollapsibleNav'

import { resolveComponentLibraryEntryDisplayName } from '../models/componentLibraryLocalization'
import type { ComponentLibrarySection } from '../models/componentLibraryTypes'

import { formatLayer } from './componentLibraryFormatters'
import type { ComponentLibraryTranslate } from './componentLibraryPageTypes'

import styles from '@catalog/styles/ComponentLibraryPage.module.css'

interface ComponentLibraryNavProps {
  sections: ComponentLibrarySection[]
  selectedEntryId: Nullable<string>
  onSelectEntry: (entryId: string) => void
  t: ComponentLibraryTranslate
}

export const ComponentLibraryNav = memo(function ComponentLibraryNav({
  sections,
  selectedEntryId,
  onSelectEntry,
  t,
}: ComponentLibraryNavProps): ReactElement {
  const groups = sections.map((section) => ({
    id: section.id,
    title: section.title,
    count: section.entries.length,
    items: section.entries.map((entry) => ({
      id: entry.id,
      label: resolveComponentLibraryEntryDisplayName(t, entry.id, entry.name),
      description: formatLayer(entry.layer, t),
    })),
  }))

  return (
    <CollapsibleNav
      className={styles.sectionNav}
      itemLabel={t('componentLibrary.sectionsAriaLabel')}
      groups={groups}
      selectedItemId={selectedEntryId}
      defaultOpenGroupIds={sections.map((section) => section.id)}
      onSelect={onSelectEntry}
    />
  )
})

ComponentLibraryNav.displayName = 'ComponentLibraryNav'
