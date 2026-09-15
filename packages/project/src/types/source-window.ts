export interface ProjectSourceLine { line: number; start: number; bodyEnd: number; end: number; text: string }

export interface ProjectSourceFragment { line: number; columns: [number, number]; text: string }

export interface ProjectSourceWindow {
  kind: 'project-source-window'
  path: string
  revision?: string
  viewSource?: string
  fileRef?: string
  lines: Array<[number, string]>
  fragments?: ProjectSourceFragment[]
  [key: string]: unknown
}
