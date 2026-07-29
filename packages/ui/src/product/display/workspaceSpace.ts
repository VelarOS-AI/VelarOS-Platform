export const WorkspaceSpaceKind = {
  Browser: 'browser',
  Project: 'project',
  System: 'system',
} as const

export type WorkspaceSpaceKind =
  (typeof WorkspaceSpaceKind)[keyof typeof WorkspaceSpaceKind]

export function getWorkspaceSpaceIconName(
  space: WorkspaceSpaceKind
): 'browser' | 'desktop' | 'folder-open' {
  switch (space) {
    case WorkspaceSpaceKind.Browser:
      return 'browser'
    case WorkspaceSpaceKind.Project:
      return 'folder-open'
    case WorkspaceSpaceKind.System:
      return 'desktop'
  }
}
