import type {
  ComponentLibraryEntry,
  ComponentLibrarySection,
} from '@catalog/models/componentLibraryTypes'

import type {
  ComponentLibraryEntryRegistration,
  ComponentLibrarySectionModule,
} from './componentLibraryRegistryTypes'

interface RegistryGlobModule<T> {
  default: T
}

interface MutableRegisteredSection {
  entries: Array<{ entry: ComponentLibraryEntry; order: number }>
  order: number
  title: string
}

const sectionModules = import.meta.glob<RegistryGlobModule<ComponentLibrarySectionModule>>(
  './sections/*.section.tsx',
  { eager: true }
)
const entryModules = import.meta.glob<RegistryGlobModule<ComponentLibraryEntryRegistration>>(
  './entries/**/*.entry.tsx',
  { eager: true }
)

function toRegisteredSections(module: ComponentLibrarySectionModule): Array<{
  order: number
  section: ComponentLibrarySection
}> {
  const sections = (module as { sections?: ComponentLibrarySection[] }).sections
  if (sections) return sections.map((section, index) => ({
      order: (module.order ?? 0) + index / 100,
      section,
    }))

  const single = module as { order?: number; section: ComponentLibrarySection }
  return [{ order: single.order ?? 0, section: single.section }]
}

function upsertSection(
  sectionsById: Map<string, MutableRegisteredSection>,
  sectionId: string,
  title: string,
  order: number
): MutableRegisteredSection {
  const existing = sectionsById.get(sectionId)

  if (existing) {
    existing.order = Math.min(existing.order, order)
    if (!existing.title) {
      existing.title = title
    }
    return existing
  }

  const nextSection: MutableRegisteredSection = {
    entries: [],
    order,
    title,
  }
  sectionsById.set(sectionId, nextSection)

  return nextSection
}

function buildComponentLibrarySections(): ComponentLibrarySection[] {
  const sectionsById = new Map<string, MutableRegisteredSection>()

  Object.values(sectionModules)
    .flatMap((module) => toRegisteredSections(module.default))
    .forEach(({ order, section }) => {
      const registeredSection = upsertSection(sectionsById, section.id, section.title, order)
      registeredSection.entries.push(
        ...section.entries.map((entry, index) => ({ entry, order: index }))
      )
    })

  Object.values(entryModules).forEach((module) => {
    const registration = module.default
    const section = upsertSection(
      sectionsById,
      registration.sectionId,
      registration.sectionTitle,
      registration.sectionOrder ?? 100
    )
    section.entries.push({
      entry: registration.entry,
      order: registration.entryOrder ?? section.entries.length,
    })
  })

  return [...sectionsById.entries()]
    .sort(([, left], [, right]) => left.order - right.order || left.title.localeCompare(right.title))
    .map(([id, section]) => ({
      id,
      title: section.title,
      entries: section.entries
        .sort((left, right) => left.order - right.order || left.entry.name.localeCompare(right.entry.name))
        .map(({ entry }) => entry),
    }))
}

export const componentLibrarySections: ComponentLibrarySection[] = buildComponentLibrarySections()
