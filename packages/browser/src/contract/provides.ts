import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec,ToolContractSurface } from '@velaros-ai/agent/tool-contract'

import type { BrowserToolContext } from './requires.js'

export type VelaToolSurface<
  TSurfaceInput extends Record<string, unknown> = Record<string, unknown>,
  TBaseInput extends Record<string, unknown> = Record<string, unknown>,
> = ToolContractSurface<TSurfaceInput, TBaseInput, BrowserToolContext>

export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, BrowserToolContext, unknown, ToolPermission>
