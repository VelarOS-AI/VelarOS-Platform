import {
  createToolSchemaBundle,
  schemaToInputSchema,
  type ToolSchemaBundle,
  type ToolSchemaSource,
} from '@velaros-ai/core/tool-contract'

export type { ToolSchemaSource }
export type WorkspaceToolSchemaBundle = ToolSchemaBundle
export { schemaToInputSchema }

export function createWorkspaceToolSchemaBundle(
  tools: readonly ToolSchemaSource[]
): WorkspaceToolSchemaBundle {
  return createToolSchemaBundle(tools, {
    sharedSchemaExternalUri: 'workspace-shared',
  })
}
