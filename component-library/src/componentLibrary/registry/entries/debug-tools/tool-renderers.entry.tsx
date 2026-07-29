import { ToolRendererExample } from '@catalog/examples/DebugExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.debugTools,
  entryOrder: 10,
  entry: {
    id: 'tool-renderers',
    name: 'Tool Renderers',
    layer: 'Feature',
    status: 'ready',
    domain: 'Debug / Tool output',
    source: '@velaros-ai/ui/conversation',
    origin: 'packages/ui/src/conversation/tool-render',
    exampleMode: 'fixture',
    usage:
      'Use shared compact rows and disclosure cards for command, plan (update_plan), file and rich tool output.',
    avoid:
      'Do not create one-off tool result cards when ToolDisclosureCard or CompactToolRow fits.',
    examples: [
      {
        id: 'tool-renderers-fixture',
        label: 'Fixture: command + update_plan outputs',
        node: <ToolRendererExample />,
      },
    ],
    api: [
      {
        name: 'ToolCallBlock.block',
        description:
          'For update_plan ToolCallBlocks, routing dispatches from ToolCallBlock to PlanToolRender (see packages/ui/src/conversation/tool-render/plan).',
        type: 'ToolCallBlock',
      },
      {
        name: 'ToolCallBlock.compact',
        description: 'Use compact rendering in conversation top docks or narrow panels.',
        type: 'boolean',
        defaultValue: 'false',
      },
    ],
  },
})
