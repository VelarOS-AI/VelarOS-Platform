import {
  SidebarPreview,
  WorkspaceGitCommitControlPreview,
  WorkspaceSessionControlPreview,
} from '@catalog/adapters/PreviewAdapters'
import type { ReactElement } from 'react'

import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

export function SidebarExample(): ReactElement {
  return (
    <div data-library-shell-sample>
      <SidebarPreview />
    </div>
  )
}

export function TopBarControlsExample(): ReactElement {
  return (
    <Inline gap="sm" wrap="wrap" justify="end">
      <WorkspaceSessionControlPreview />
      <WorkspaceGitCommitControlPreview branch="main" additions={24} deletions={8} changedFiles={2} />
    </Inline>
  )
}
