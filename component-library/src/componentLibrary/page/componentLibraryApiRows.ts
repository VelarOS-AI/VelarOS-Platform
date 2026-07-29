import { isEmpty } from '@catalog/catalogPrimitives'

import { generatedComponentApiRows } from '../generated/componentApi.generated'
import type {
  ComponentLibraryApiRow,
  ComponentLibraryEntry,
} from '../models/componentLibraryTypes'

import type { ComponentLibraryTranslate } from './componentLibraryPageTypes'

function normalizeApiComponentName(value: string): string {
  return value
    .trim()
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/[^\w]/g, '')
}

function inferApiComponentNames(entry: ComponentLibraryEntry): string[] {
  return entry.name
    .split('/')
    .map(normalizeApiComponentName)
    .filter((name) => name.length > 0)
}

function getGeneratedApiRows(entry: ComponentLibraryEntry): ComponentLibraryApiRow[] {
  const componentNames = entry.apiComponents ?? inferApiComponentNames(entry)

  return componentNames.flatMap((componentName) => generatedComponentApiRows[componentName] ?? [])
}

function mergeApiRows(
  generatedRows: ComponentLibraryApiRow[],
  overrideRows: ComponentLibraryApiRow[] = []
): ComponentLibraryApiRow[] {
  if (isEmpty(generatedRows)) return overrideRows

  if (isEmpty(overrideRows)) return generatedRows

  const overridesByName = new Map(overrideRows.map((row) => [row.name, row]))
  const mergedRows = generatedRows.map((row) => ({
    ...row,
    ...overridesByName.get(row.name),
  }))
  const generatedNames = new Set(generatedRows.map((row) => row.name))
  const remainingOverrideRows = overrideRows.filter((row) => !generatedNames.has(row.name))

  return [...mergedRows, ...remainingOverrideRows]
}

export function getDefaultApiRows(
  entry: ComponentLibraryEntry,
  t: ComponentLibraryTranslate
): ComponentLibraryApiRow[] {
  const generatedRows = getGeneratedApiRows(entry)

  if (entry.api && !isEmpty(entry.api)) return mergeApiRows(generatedRows, entry.api)

  if (!isEmpty(generatedRows)) return generatedRows

  switch (entry.layer) {
    case 'UI': {
      return [
      {
        name: 'variant',
        description: t('componentLibrary.apiVariantDescription'),
        type: "'default' | 'secondary' | 'outline' | 'ghost' | string",
        defaultValue: "'default'",
        recommended: "'default' | 'outline'",
      },
      {
        name: 'size',
        description: t('componentLibrary.apiSizeDescription'),
        type: "'sm' | 'md' | 'lg' | string",
        defaultValue: "'md'",
        recommended: "'sm'",
      },
      {
        name: 'disabled',
        description: t('componentLibrary.apiDisabledDescription'),
        type: 'boolean',
        defaultValue: 'false',
      },
    ]
    }
    case 'Business': {
      return [
      {
        name: 'viewModel',
        description: t('componentLibrary.apiViewModelDescription'),
        type: 'object',
        recommended: t('componentLibrary.apiRecommendedMappedViewModel'),
      },
      {
        name: 'actions',
        description: t('componentLibrary.apiActionsDescription'),
        type: 'object',
        recommended: t('componentLibrary.apiRecommendedSideEffectAdapter'),
      },
      {
        name: 'copy',
        description: t('componentLibrary.apiCopyDescription'),
        type: 'object',
        recommended: t('componentLibrary.apiRecommendedLocalizedCopy'),
      },
    ]
    }
    case 'Feature': {
      return [
      {
        name: 'surfaceState',
        description: t('componentLibrary.apiSurfaceStateDescription'),
        type: 'object',
      },
      {
        name: 'callbacks',
        description: t('componentLibrary.apiCallbacksDescription'),
        type: 'object',
      },
    ]
    }
    case 'Token': {
      return [
      {
        name: 'token',
        description: t('componentLibrary.apiTokenDescription'),
        type: 'CSS variable',
      },
      {
        name: 'scope',
        description: t('componentLibrary.apiTokenScopeDescription'),
        type: "'root' | 'workbench' | string",
      },
    ]
    }
    default: {
      return [
    {
      name: 'scope',
      description: t('componentLibrary.apiVisualScopeDescription'),
      type: 'string',
    },
    {
      name: 'tokens',
      description: t('componentLibrary.apiVisualTokensDescription'),
      type: 'CSS variable set',
    },
  ]
    }
  }
}
