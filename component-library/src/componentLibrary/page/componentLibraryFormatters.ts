import type { ComponentLibraryLayer } from '../models/componentLibraryTypes'

import type { ComponentLibraryTranslate } from './componentLibraryPageTypes'

export function formatLayer(layer: ComponentLibraryLayer, t: ComponentLibraryTranslate): string {
  switch (layer) {
    case 'UI': {
      return t('componentLibrary.layerUi')
    }
    case 'Business': {
      return t('componentLibrary.layerBusiness')
    }
    case 'Feature': {
      return t('componentLibrary.layerFeature')
    }
    case 'Token': {
      return t('componentLibrary.layerToken')
    }
    default: {
      return t('componentLibrary.layerVisual')
    }
  }
}
