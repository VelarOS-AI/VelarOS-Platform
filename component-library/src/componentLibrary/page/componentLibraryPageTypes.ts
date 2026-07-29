import type { I18nContextValue } from '@catalog/i18n'

import type {
  ComponentLibraryEntry,
  ComponentLibrarySection,
} from '../models/componentLibraryTypes'

/** 与本地化翻译函数形态一致，供页面子组件使用。 */
export type ComponentLibraryTranslate = I18nContextValue['t']

export interface ComponentLibraryListEntry {
  section: ComponentLibrarySection
  entry: ComponentLibraryEntry
}
