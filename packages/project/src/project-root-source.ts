export const ProjectRootSource = {
  Project: 'project',
} as const

export type ProjectRootSource =
  (typeof ProjectRootSource)[keyof typeof ProjectRootSource]

export function isProjectRootSource(
  source: unknown,
): source is typeof ProjectRootSource.Project {
  return source === ProjectRootSource.Project
}
