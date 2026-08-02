import { structureToolDescriptionsForCategory } from '@velaros-ai/core/utils/ToolDescription'

import { browserArtifactTools } from './Artifacts.tool'
import { browserEventTools } from './Events.tool'
import { browserExportTools } from './Export.tool'
import { browserExtractionTools } from './Extraction.tool'
import { browserFetchTools } from './Fetch.tool'
import { browserInspectionTools } from './Inspection.tool'
import { browserInteractionTools } from './Interaction.tool'
import { browserPageDataTools } from './PageData.tool'
import { browserPerformanceTools } from './Performance.tool'
import { browserRecipeTools } from './Recipe.tool'
import { browserScreencastTools } from './Screencast.tool'
import { browserSessionTools } from './Sessions.tool'
import { browserUploadTools } from './Upload.tool'
import { browserUserScriptTools } from './UserScripts.tool'

/**
 * Browser Use 工具集合。
 *
 * 这里把 session、检查、交互、页面数据抽取、artifact 和 recipe 工具整合成
 * browser 类别的公开工具名。具体实现分散在本包的相邻模块中。
 */
const rawBrowserTools = {
  ...browserSessionTools,
  ...browserInspectionTools,
  ...browserInteractionTools,
  ...browserEventTools,
  ...browserUploadTools,
  ...browserFetchTools,
  ...browserPageDataTools,
  ...browserExtractionTools,
  ...browserExportTools,
  ...browserPerformanceTools,
  ...browserScreencastTools,
  ...browserArtifactTools,
  ...browserRecipeTools,
  ...browserUserScriptTools,
}

export const browserTools = structureToolDescriptionsForCategory(rawBrowserTools, 'browser')
