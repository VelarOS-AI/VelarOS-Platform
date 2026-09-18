import type { CommandProvider,ProjectProviders } from '../contract/requires.js'

import type { TrustLabel } from "./common.js";

export interface MissingCommandDetectionInput {
  command: string;
  sourceCommand?: string;
  exitCode?: LooseOptional<number>;
  stderr?: string;
  error?: any;
}

export type ProjectRuntimeProviders = ProjectProviders & {
  command: CommandProvider
}

export interface ProjectIntelligenceSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  exported: boolean;
  nodeId?: LooseOptional<string>;
  signature?: LooseOptional<string>;
}

export interface ProjectIntelligenceLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  nodeId?: LooseOptional<string>;
}

export interface FileFilterInput {
  path: string;
  action: "read" | "write" | "search" | "observe";
}

export interface RedactionInput {
  path?: string;
  content: string;
  trust?: TrustLabel;
}

export interface RedactionResult {
  content: string;
  redacted: boolean;
  markers?: string[];
}

export type CommandToolRequirementKind = "missing-command";

export interface CommandToolRequirement {
  kind: CommandToolRequirementKind;
  /** 操作完成前必须安装或暴露出来的命令。 */
  command: string;
  reason?: string;
  sourceCommand?: string;
}

export interface CommandRunInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  stdin?: string;
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  timedOut?: boolean;
  /** 任一输出流达到宿主缓冲上限，当前输出和搜索结果可能不完整。 */
  truncated?: boolean;
  toolRequirements?: CommandToolRequirement[];
}


/** 解析可执行文件（utils/kernel/executable-path.ts）时可以换掉的三件事：按哪个平台的语义、读哪份环境变量、怎么判断文件在不在。 */
export interface ExecutableLookupOptions {
  /** 按哪个平台的语义解析（`win32` 或其他）；缺省当前进程的平台。 */
  readonly platform?: string
  /** 从哪份环境变量里读 PATH 与 PATHEXT；缺省当前进程的。 */
  readonly env?: NodeJS.ProcessEnv
  /** 判断一个候选文件在不在；缺省 existsSync。 */
  readonly exists?: (candidate: string) => boolean
}
