export const WorkspaceRootSource = {
  Project: 'project',
} as const

export type WorkspaceRootSource =
  (typeof WorkspaceRootSource)[keyof typeof WorkspaceRootSource]

export function isProjectWorkspaceRootSource(
  source: unknown,
): source is typeof WorkspaceRootSource.Project {
  return source === WorkspaceRootSource.Project
}
