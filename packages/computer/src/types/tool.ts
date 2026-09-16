/** 六个工具自己的工作类型：模型给的入参形状、坐标解析的中间结果、能力声明的形状。 */

import type { ToolCapabilitySchema, ToolPermission } from '@velaros-ai/agent/contracts'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/tool-contract'

import type { ComputerToolContext } from '../contract/requires.js'

import type { ComputerCoordinateSpace } from './computer.js'

/** `computer:move` 的入参：与点击同一套坐标契约，主屏坐标必须带截图绑定，全局坐标必须不带。 */
export type ComputerPointInput = Record<string, unknown> & {
  x: number
  y: number
} & (
  | {
      coordinateSpace?: 'primary-display'
      snapshotId: string
    }
  | {
      coordinateSpace: 'global'
      snapshotId?: never
    }
)

/** `computer:click` 的入参：主屏坐标必须带截图绑定，全局坐标必须不带。 */
export type ComputerClickInput = Record<string, unknown> & {
  x: number
  y: number
} & {
  button?: 'left' | 'right' | 'middle'
  count?: number
} & (
  | {
      coordinateSpace?: 'primary-display'
      snapshotId: string
    }
  | {
      coordinateSpace: 'global'
      snapshotId?: never
    }
)

/** 坐标解析的结果：换算好的全局坐标、模型给的局部坐标，以及回执要带上的绑定信息。 */
export interface ResolvedComputerPoint {
  x: number
  y: number
  localX: number
  localY: number
  coordinateSpace: ComputerCoordinateSpace
  displayId?: number
  snapshotId?: string
}

/** 桌面控制工具的能力声明形状：在上游能力声明上多带一格 metadata。 */
export type ComputerToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}

/** 定义一个桌面控制工具时要填的东西：类别由 defineComputerTool 统一补上，所以这里不填。 */
export type DefineComputerToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, ComputerToolContext, unknown, ToolPermission>,
  'category'
>
