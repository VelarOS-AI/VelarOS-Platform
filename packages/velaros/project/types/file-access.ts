import type { TextEncoding } from '@velaros-ai/core/text-files/contracts'

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

/** 文件访问端口；所有实现均负责根目录约束（出不了项目根），点名访问不按名单拒。 */
export interface ProjectFileAccess {
  authorize(path: string): Promise<{ abs: string; rel: string }>
  /** 列举、扫描、搜索时一个条目出不出现（宿主的列举过滤器）；点名访问不问它。 */
  visible(rel: string, action: FileFilterInput['action']): Promise<boolean>
  snapshot(path: string, includeContent?: boolean): Promise<FileSnapshot>
  read(input: ReadInput): Promise<ReadResult>
  stat(input: FileStatInput): Promise<FileStatResult>
  listFiles(input?: ObserveInput): Promise<FileListEntry[]>
  observe(input?: ObserveInput): Promise<ProjectSnapshot>
  write(
    path: string,
    content: string,
    options?: { encoding?: TextEncoding; mode?: number },
  ): Promise<FileSnapshot>
  remove(path: string): Promise<void>
}
