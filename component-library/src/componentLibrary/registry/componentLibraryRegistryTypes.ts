import type {
  ComponentLibraryEntry,
  ComponentLibrarySection,
} from '@catalog/models/componentLibraryTypes'

export interface ComponentLibrarySectionRegistration {
  order?: number
  section: ComponentLibrarySection
}

export interface ComponentLibrarySectionGroupRegistration {
  order?: number
  sections: ComponentLibrarySection[]
}

export interface ComponentLibraryEntryRegistration {
  sectionId: string
  sectionTitle: string
  sectionOrder?: number
  entryOrder?: number
  entry: ComponentLibraryEntry
}

export type ComponentLibrarySectionModule =
  | ComponentLibrarySectionRegistration
  | ComponentLibrarySectionGroupRegistration

export function defineComponentLibraryEntry(
  registration: ComponentLibraryEntryRegistration
): ComponentLibraryEntryRegistration {
  return registration
}
