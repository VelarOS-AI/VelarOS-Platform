import { structureToolDescriptionsForCategory } from '@velaros-ai/core/utils/ToolDescription'

import { markitdownTools } from './markitdown.tool'
import { pdfTools } from './pdf.tool'
import { presentationTools } from './presentation.tool'
import { previewTools } from './preview.tool'
import { spreadsheetTools } from './spreadsheet.tool'
import { wordTools } from './word.tool'

/** Office category public tool collection. */
const rawOfficeTools = {
  ...wordTools,
  ...presentationTools,
  ...spreadsheetTools,
  ...pdfTools,
  ...previewTools,
  ...markitdownTools,
}

export const officeTools = structureToolDescriptionsForCategory(
  rawOfficeTools,
  'office',
)
