import type { ComponentLibraryEntry } from '../models/componentLibraryTypes'

export function getRecommendedUsageExamples(
  entry: ComponentLibraryEntry
): ComponentLibraryEntry['examples'] {
  if (entry.layer === 'Business') return entry.examples

  return []
}

export function getGeneralUsageExamples(
  entry: ComponentLibraryEntry
): ComponentLibraryEntry['examples'] {
  if (entry.layer === 'Business') return entry.generalExamples ?? []

  return entry.examples
}
