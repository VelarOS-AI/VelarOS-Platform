import { isEmpty } from '@catalog/catalogPrimitives'

import { resolveComponentLibraryEntryDisplayName } from '../models/componentLibraryLocalization'
import type {
  ComponentLibraryEntry,
  ComponentLibrarySection,
} from '../models/componentLibraryTypes'

import type { ComponentLibraryListEntry, ComponentLibraryTranslate } from './componentLibraryPageTypes'

export function getEntrySearchText(
  entry: ComponentLibraryEntry,
  sectionTitle: string,
  t: ComponentLibraryTranslate
): string {
  const entryDisplayLocale = resolveComponentLibraryEntryDisplayName(t, entry.id, entry.name)

  return [
    sectionTitle,
    entryDisplayLocale,
    entry.name,
    entry.layer,
    entry.status,
    entry.domain,
    entry.source,
    entry.origin ?? '',
    entry.documentation ?? '',
    entry.exampleMode ?? '',
    entry.usage,
    entry.avoid,
    ...(entry.apiComponents ?? []),
    ...(entry.recommendations ?? []).flatMap((recommendation) => [
      recommendation.title,
      recommendation.description,
      recommendation.code,
    ]),
    ...(entry.api ?? []).flatMap((row) => [
      row.name,
      row.description,
      row.type,
      row.defaultValue ?? '',
      row.recommended ?? '',
    ]),
    ...entry.examples.map((example) => example.label),
    ...(entry.generalExamples ?? []).map((example) => example.label),
  ]
    .join(' ')
    .toLowerCase()
}

export function getVisibleSections({
  normalizedQuery,
  sections,
  t,
}: {
  normalizedQuery: string
  sections: ComponentLibrarySection[]
  t: ComponentLibraryTranslate
}): ComponentLibrarySection[] {
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => {
        if (!normalizedQuery) return true

        return getEntrySearchText(entry, section.title, t).includes(normalizedQuery)
      }),
    }))
    .filter((section) => !isEmpty(section.entries))
}

export function flattenSections(sections: ComponentLibrarySection[]): ComponentLibraryListEntry[] {
  return sections.flatMap((section) => section.entries.map((entry) => ({ section, entry })))
}
