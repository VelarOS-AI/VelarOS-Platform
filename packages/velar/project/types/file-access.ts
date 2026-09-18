import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import type {
  FileListEntry,
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  ReadResult,
} from './io.js'
import type { FileFilterInput } from './provider.js'
import type { FileSnapshot, ProjectSnapshot } from './snapshot.js'

/** 文件访问端口；所有实现均负责根目录约束和 deny 规则。 */
export interface ProjectFileAccess {
  authorize(
    path: string,
    action: FileFilterInput['action'],
    label: string,
    options?: FileAccessOptions,
  ): Promise<{ abs: string; rel: string }>
  snapshot(
    path: string,
    includeContent?: boolean,
    options?: FileAccessOptions,
  ): Promise<FileSnapshot>
  read(input: ReadInput, options?: FileAccessOptions): Promise<ReadResult>
  stat(input: FileStatInput, options?: FileAccessOptions): Promise<FileStatResult>
  listFiles(input?: ObserveInput): Promise<FileListEntry[]>
  observe(input?: ObserveInput): Promise<ProjectSnapshot>
  write(
    path: string,
    content: string,
    options?: FileAccessOptions & { encoding?: TextEncoding; mode?: number },
  ): Promise<FileSnapshot>
  remove(path: string, options?: FileAccessOptions): Promise<void>
}

export interface FileAccessOptions {
  /** 仅跳过宿主可见性过滤，根目录约束与 deny 规则始终执行。 */
  skipFileFilter?: boolean
}
