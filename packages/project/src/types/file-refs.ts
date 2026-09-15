import type { FileContextCarrier } from '@velaros-ai/agent/tool-contract'

import type { ProjectToolApi } from '../contract/requires.js'

export interface ProjectReferenceContext extends FileContextCarrier {
  project: Pick<ProjectToolApi, 'getRootPath' | 'kernel'>
  fileRefScopeId?: string
}

export interface ProjectVisibleCoverage {
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  completeLines: boolean
}

export interface ProjectFileView {
  path: string
  revision: string
  contentRevision: string
  content: string
  coverage: ProjectVisibleCoverage[]
}

export interface SourceRecord {
  kind: 'project-file-source'
  version: 1
  workspace: string
  scope: string
  path: string
  revision: string
  contentRevision: string
  content: string
}

export interface ViewRecord {
  kind: 'project-file-view'
  version: 1
  source: string
  scope: string
  coverage: ProjectVisibleCoverage[]
}

export interface PageRecord {
  kind: 'project-read-page'
  version: 1
  source: string
  scope: string
  range: { startLine: number; startColumn?: number; endLine?: number; endColumn?: number }
}

export type RefRecord = SourceRecord | ViewRecord | PageRecord
