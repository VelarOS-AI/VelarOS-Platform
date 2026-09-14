import React from 'react'
import { FileTextIcon } from '@phosphor-icons/react'

import { DefaultToolRender } from '../DefaultToolRender.section'
import { RichToolOutputCard } from '../richOutput/RichToolOutputCard.section'

import { collectProjectSourceViews } from './projectSourceView'
import { ProjectSourceWindows } from './ProjectSourceWindows'

import type { ToolCallBlock } from '#contracts'

export function ProjectSourceToolRender({ block, compact }: { block: ToolCallBlock; compact?: boolean }) {
  const windows = collectProjectSourceViews(block.result)
  if (!windows.length || block.error || block.isRunning) return <DefaultToolRender block={block} compact={compact} />
  return <RichToolOutputCard icon={<FileTextIcon size={14} />} title={block.title || block.toolName}
    subtitle={[...new Set(windows.map((window) => window.path))].join(', ')} toolBlock={block} compact={compact} tone="success">
    <ProjectSourceWindows value={block.result} />
  </RichToolOutputCard>
}
