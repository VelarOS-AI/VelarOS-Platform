export interface ProjectSandboxInput {
  action: 'create' | 'run' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: 'link' | 'copy' | 'skip'
  sandboxId?: string
  command?: string
  timeoutMs?: number
  maxOutputChars?: number
  paths?: string[]
  maxFiles?: number
}
