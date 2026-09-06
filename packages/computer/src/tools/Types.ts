import type { ToolExecutionApi, ToolPermission } from '@velaros-ai/agent/protocol'
import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'

import type {
  ComputerAvailability,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerKeyResult,
  ComputerMoveResult,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerTypeResult,
} from '../runtime'

/**
 * Desktop-control API surface a tool sees. The host (ToolContext) adapts the
 * computer-runtime sidecar manager into this shape, and screenshot results are
 * returned as a model-facing image artifact in Phase 2; Phase 1 returns the
 * raw runtime result so tools stay thin.
 */
export interface ToolComputerApi {
  /** Probe availability + OS permissions without throwing. */
  ensureAvailable: () => Promise<ComputerAvailability>
  /** Logical screen geometry of the primary display. */
  screenSize: () => Promise<ComputerScreenSize>
  /** Capture the primary display (always at logical resolution for 1:1 click coords). */
  screenshot: () => Promise<ComputerScreenshot>
  /** Move the cursor using virtual-desktop global logical coordinates. */
  mouseMove: (x: number, y: number) => Promise<ComputerMoveResult>
  /**
   * Click in the selected coordinate space. Primary-display coordinates must carry the
   * snapshotId returned by screenshot(); the runtime validates it immediately before input.
   */
  click: (
    x: number,
    y: number,
    options?: ComputerClickOptions
  ) => Promise<ComputerClickResult>
  /** Type literal text at the current focus. */
  typeText: (text: string) => Promise<ComputerTypeResult>
  /** Press a key or key combination (e.g. "cmd+a", "enter"). */
  key: (keys: string) => Promise<ComputerKeyResult>
}

export interface ComputerToolContext {
  abortSignal: AbortSignal
  computer: ToolComputerApi
  /** Execution API for the confirmation flow; absent in background contexts. */
  execution: Nullable<ToolExecutionApi>
}

export type ToolContext = ComputerToolContext

export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, ComputerToolContext, unknown, ToolPermission>

type DefineComputerToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, ComputerToolContext, unknown, ToolPermission>,
  'category'
>

export function defineComputerTool<TInput extends Record<string, unknown>>(
  input: DefineComputerToolInput<TInput>
): VelaTool<TInput> {
  return defineToolRuntimeSpec({ ...input, category: 'computer-control' })
}
