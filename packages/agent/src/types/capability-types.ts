import type {
  ToolDiscoveryAvailability,
  ToolDiscoveryNextAction,
  ToolDiscoverySchemaState,
} from '../utils/tools/discovery-availability'

import type {
  ToolAvailabilityScope,
  ToolCategoryId,
  ToolDescriptor,
  ToolPermission,
} from './tool'
import type { RegisteredTool, RegistryTool, ToolRegistryContext } from './tools'

type RegisteredToolMap<TTool extends RegistryTool<any> = RegistryTool<any>> = Map<
  string,
  RegisteredTool<TTool>
>

type ToolCapabilityPageKind = 'tool'
type ToolCapabilitySchemaPolicy = 'full' | 'preview' | 'hidden' | 'none'

interface ToolCapabilityReason {
  layer: string
  code: string
  message: string
  details?: Record<string, unknown>
}

interface ToolCapabilityPage {
  id: string
  kind: ToolCapabilityPageKind
  name: string
  categoryId: ToolCategoryId
  descriptor: ToolDescriptor
  permissions: ToolPermission[]
  availability: ToolDiscoveryAvailability
  schemaState: ToolDiscoverySchemaState
  schemaPolicy: ToolCapabilitySchemaPolicy
  nextAction: ToolDiscoveryNextAction
  resident: boolean
  reasons: ToolCapabilityReason[]
}

interface ToolCapabilityRegistryListOptions {
  allowList?: string[]
  scope?: ToolAvailabilityScope
}

type ToolCapabilityRegistryContext = ToolRegistryContext & {
  getCurrentVisibleToolNames(): string[]
}

export type {
  RegisteredToolMap,
  ToolCapabilityPage,
  ToolCapabilityPageKind,
  ToolCapabilityReason,
  ToolCapabilityRegistryContext,
  ToolCapabilityRegistryListOptions,
  ToolCapabilitySchemaPolicy,
}
