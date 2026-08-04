import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { computerInputTools } from './Input.tool'
import { computerScreenTools } from './Screen.tool'

/**
 * Computer Use 工具集合（OS 级桌面控制，Phase 1）。
 *
 * 截图/屏幕尺寸为只读 read 档；移动/点击/输入/按键为高风险 control 档，
 * 全部经过 ToolContext 的确认流程。整组类别默认关闭，需显式 opt-in。
 */
const rawComputerTools = {
  ...computerScreenTools,
  ...computerInputTools,
}

export const computerTools = structureToolDescriptionsForCategory(
  rawComputerTools,
  'computer-control'
)
