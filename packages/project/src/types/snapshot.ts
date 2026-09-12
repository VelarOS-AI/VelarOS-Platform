import type { ProjectTextEncoding } from "../utils/text.js";

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
  /**
   * 文本正文在磁盘上的实际编码，仅在不是无 BOM 的 UTF-8 时出现（UTF-8 BOM、UTF-16、GB18030）。
   * 删除后回滚、重命名都要在空路径上重建文件，据此沿用原编码，而不是改写成 UTF-8。
   */
  textEncoding?: ProjectTextEncoding;
  /** 路径本身是符号链接（正文与 revision 来自链接目标），仅在为真时出现。 */
  isSymbolicLink?: boolean;
  mime?: string;
  sha256: string;
  /** 由 path、hash、mtime 和 size 推导出的稳定 revision token。 */
  revision: string;
  mtimeMs: number;
  adapterIds: string[];
}

/** 紧凑的工作区整体指纹，用于发现和变更跟踪。 */
export interface ProjectSnapshot {
  root: string;
  revision: string;
  files: Array<Pick<FileSnapshot, "path" | "size" | "sha256" | "revision" | "mtimeMs" | "isBinary" | "adapterIds">>;
  createdAt: number;
}
