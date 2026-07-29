/** 单个路径的时间点视图，包含乐观并发控制使用的 revision 数据。 */
export interface FileSnapshot {
  path: string;
  absPath: string;
  exists: boolean;
  isDirectory: boolean;
  isBinary: boolean;
  /** 仅在非二进制文件足够小，或调用方显式读取内容时存在。 */
  content?: string;
  size: number;
  encoding?: "utf8" | "binary";
  mime?: string;
  sha256: string;
  /** 由 path、hash、mtime 和 size 推导出的稳定 revision token。 */
  revision: string;
  mtimeMs: number;
  adapterIds: string[];
}

/** 紧凑的工作区整体指纹，用于发现和变更跟踪。 */
export interface WorkspaceSnapshot {
  root: string;
  revision: string;
  files: Array<Pick<FileSnapshot, "path" | "size" | "sha256" | "revision" | "mtimeMs" | "isBinary" | "adapterIds">>;
  createdAt: number;
}
