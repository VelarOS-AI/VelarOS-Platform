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
  /** 进入/退出 browser site 模式。 */
  enter_browser_site: browserSessionTools.enter_browser_site,
  leave_browser_site: browserSessionTools.leave_browser_site,
  /** 页面状态和窗口显示控制。 */
  browser_get_page_state: browserInspectionTools.browser_get_page_state,
  browser_show_page: browserSessionTools.browser_show_page,
  browser_hide_page: browserSessionTools.browser_hide_page,
  browser_list_page_targets: browserSessionTools.browser_list_page_targets,
  browser_switch_page_target: browserSessionTools.browser_switch_page_target,
  /** 当前站点上下文与私有工作区 manifest。 */
  get_browser_site_context: browserSessionTools.get_browser_site_context,
  get_browser_workspace_manifest: browserSessionTools.get_browser_workspace_manifest,
  /** 页面结构检查和截图。 */
  browser_inspect_page: browserInspectionTools.browser_inspect_page,
  browser_observe_actions: browserInspectionTools.browser_observe_actions,
  browser_capture_screenshot: browserInspectionTools.browser_capture_screenshot,
  /** 页面交互动作。 */
  ...browserInteractionTools,
  browser_query_elements: browserInspectionTools.browser_query_elements,
  browser_get_page_diagnostics: browserInspectionTools.browser_get_page_diagnostics,
  browser_list_console_events: browserInspectionTools.browser_list_console_events,
  browser_list_network_events: browserInspectionTools.browser_list_network_events,
  browser_get_network_request: browserInspectionTools.browser_get_network_request,
  browser_get_network_response_body: browserInspectionTools.browser_get_network_response_body,
  browser_list_page_errors: browserInspectionTools.browser_list_page_errors,
  /** 精确查询元素视口坐标，用于坐标点击前定位。 */
  browser_get_element_bounds: browserInspectionTools.browser_get_element_bounds,
  /** 阻塞事件处理与文件上传。 */
  ...browserEventTools,
  ...browserUploadTools,
  ...browserFetchTools,
  /** 页面存储读取、脚本评估和结构化抽取。 */
  browser_read_page_storage: browserPageDataTools.browser_read_page_storage,
  browser_evaluate_script: browserPageDataTools.browser_evaluate_script,
  ...browserExtractionTools,
  /** WYSIWYG 统一导出入口。 */
  browser_export_page: browserExportTools.browser_export_page,
  browser_capture_region: browserInspectionTools.browser_capture_region,
  /** 性能 trace 录制与 insight 分析。 */
  browser_performance: browserPerformanceTools.browser_performance,
  /** 页面录屏（GIF 产物）。 */
  browser_screencast: browserScreencastTools.browser_screencast,
  /** 展开 artifact/recipe 工具，保持公开工具名由子模块定义。 */
  ...browserArtifactTools,
  ...browserRecipeTools,
  ...browserUserScriptTools,
}

export const browserTools = structureToolDescriptionsForCategory(rawBrowserTools, 'browser')
