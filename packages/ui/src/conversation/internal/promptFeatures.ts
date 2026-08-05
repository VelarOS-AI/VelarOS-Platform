import type { ChatPromptFeatureId, ToolCategoryId } from '#contracts'

export type PromptFeatureIconId =
  | 'office'
  | 'computer'
  | 'html'
  | 'widget'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'latex'

export interface PromptFeatureManifest {
  id: ChatPromptFeatureId
  label: string
  labelKey: PromptFeatureLabelKey
  iconId: PromptFeatureIconId
  toolCategoryIds: readonly ToolCategoryId[]
  parentId?: ChatPromptFeatureId
  pluginFeature?: boolean
}

export interface PromptFeatureGroupManifest {
  id: string
  featureIds: readonly ChatPromptFeatureId[]
  labelKey: PromptFeatureLabelKey
  iconId: PromptFeatureIconId
  parentId?: ChatPromptFeatureId
}

export type PromptFeatureLabelKey =
  | 'chat.composerPlanMode'
  | 'chat.composerPluginOffice'
  | 'chat.composerPluginDocuments'
  | 'chat.composerPluginSpreadsheets'
  | 'chat.composerPluginPresentations'
  | 'chat.composerPluginPdfConvert'
  | 'chat.composerPluginPdfEdit'
  | 'chat.composerPluginPdf'
  | 'chat.composerPluginLatexPdf'
  | 'chat.composerPluginComputerUse'
  | 'chat.composerHtmlArtifacts'
  | 'chat.composerWorkbenchEditorControl'
  | 'chat.composerPluginWidget'

/**
 * 能力目录（**只含能力**）。
 *
 * 2026-08-06 拆轴：`plan` 从这里移出——它是执行模式不是能力，输入区走
 * {@link ChatInputExecutionControl}（与 goalMode 同一组），文案键 `chat.composerPlanMode` 仍在用。
 */
export const PromptFeatureManifests: readonly PromptFeatureManifest[] = [
  { id: 'office', label: 'Office', labelKey: 'chat.composerPluginOffice', iconId: 'office', toolCategoryIds: ['office'], pluginFeature: true },
  { id: 'office-document', label: 'Word', labelKey: 'chat.composerPluginDocuments', iconId: 'word', toolCategoryIds: ['office'], parentId: 'office', pluginFeature: true },
  { id: 'office-spreadsheet', label: 'Excel', labelKey: 'chat.composerPluginSpreadsheets', iconId: 'spreadsheet', toolCategoryIds: ['office'], parentId: 'office', pluginFeature: true },
  { id: 'office-presentation', label: 'PowerPoint', labelKey: 'chat.composerPluginPresentations', iconId: 'presentation', toolCategoryIds: ['office'], parentId: 'office', pluginFeature: true },
  { id: 'office-pdf-convert', label: 'PDF Convert', labelKey: 'chat.composerPluginPdfConvert', iconId: 'pdf', toolCategoryIds: ['office'], parentId: 'office', pluginFeature: true },
  { id: 'office-pdf-edit', label: 'PDF Edit', labelKey: 'chat.composerPluginPdfEdit', iconId: 'pdf', toolCategoryIds: ['office'], parentId: 'office', pluginFeature: true },
  { id: 'office-latex-pdf', label: 'LaTeX PDF', labelKey: 'chat.composerPluginLatexPdf', iconId: 'latex', toolCategoryIds: ['office'], parentId: 'office', pluginFeature: true },
  { id: 'computer-use', label: 'Computer Use', labelKey: 'chat.composerPluginComputerUse', iconId: 'computer', toolCategoryIds: ['computer-control'], pluginFeature: true },
  { id: 'html-artifact', label: 'HTML Live Preview', labelKey: 'chat.composerHtmlArtifacts', iconId: 'html', toolCategoryIds: [], pluginFeature: true },
  { id: 'workbench-editor', label: 'Workbench Editor Control', labelKey: 'chat.composerWorkbenchEditorControl', iconId: 'widget', toolCategoryIds: [] },
  { id: 'widget', label: 'Widget', labelKey: 'chat.composerPluginWidget', iconId: 'widget', toolCategoryIds: ['interaction'], pluginFeature: true },
]

export const PromptFeatureGroupManifests: readonly PromptFeatureGroupManifest[] = [
  { id: 'office-document', featureIds: ['office-document'], labelKey: 'chat.composerPluginDocuments', iconId: 'word', parentId: 'office' },
  { id: 'office-spreadsheet', featureIds: ['office-spreadsheet'], labelKey: 'chat.composerPluginSpreadsheets', iconId: 'spreadsheet', parentId: 'office' },
  { id: 'office-presentation', featureIds: ['office-presentation'], labelKey: 'chat.composerPluginPresentations', iconId: 'presentation', parentId: 'office' },
  { id: 'office-pdf', featureIds: ['office-pdf-convert', 'office-pdf-edit'], labelKey: 'chat.composerPluginPdf', iconId: 'pdf', parentId: 'office' },
  { id: 'office-latex-pdf', featureIds: ['office-latex-pdf'], labelKey: 'chat.composerPluginLatexPdf', iconId: 'latex', parentId: 'office' },
]

export const PromptFeatureOrder = PromptFeatureManifests.map((feature) => feature.id)
export const OfficePromptFeatures = PromptFeatureManifests.filter(
  (feature) => feature.parentId === 'office'
).map((feature) => feature.id)
export const PluginPromptFeatures = PromptFeatureManifests.filter(
  (feature) => feature.pluginFeature
).map((feature) => feature.id)

export function isOfficePromptFeature(feature: ChatPromptFeatureId): boolean {
  return feature === 'office' || OfficePromptFeatures.includes(feature)
}
