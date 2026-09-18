/** 坐标解析的中间结果：只在单元内部用，不出单元。 */

import type { ComputerCoordinateSpace } from './computer.js'

/** 一次移动或点击最后落在哪：换算好的全局坐标、模型给的那组坐标，以及回执要带上的显示器与截图绑定。 */
export interface ResolvedComputerPoint {
  x: number
  y: number
  localX: number
  localY: number
  coordinateSpace: ComputerCoordinateSpace
  displayId?: number
  snapshotId?: string
}
