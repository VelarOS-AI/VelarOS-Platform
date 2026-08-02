import type { TrustLabel } from "./common.js";
import type { ApprovalProvider,PolicyProvider } from "./policy.js";

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

/** Narrow injectable code-intelligence surface consumed by Project. */
export interface ProjectCodeIntelligenceHost {
  readonly available: boolean;
  isProjectEnabled(projectRoot: string): boolean;
  listSymbols(input: {
    projectRoot: string;
    path: string;
  }): Promise<ProjectIntelligenceSymbol[]>;
  getDefinition(input: {
    projectRoot: string;
    path: string;
    line: number;
    column: number;
    symbol?: string;
  }): Promise<ProjectIntelligenceLocation[]>;
}

/** 宿主提供的文件可见性过滤器，叠加在静态 deny glob 之上。 */
export interface FileFilterProvider {
  shouldInclude(input: FileFilterInput): Promise<boolean> | boolean;
}

export interface FileFilterInput {
  path: string;
  action: "read" | "write" | "search" | "observe";
}

export interface SecretRedactionProvider {
  /** 返回可以安全暴露给工具、日志和模型上下文的内容。 */
  redact(input: RedactionInput): Promise<RedactionResult> | RedactionResult;
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

export interface ContextProvider {
  /** 为 evidence pack 补充或附加宿主侧元数据。 */
  buildEvidence?(input: any): Promise<any> | any;
  /** evidence 离开 project 边界前的最后清洗步骤。 */
  sanitize?(input: any): Promise<any> | any;
}

export interface LoggerProvider {
  debug?(message: string, data?: any): void;
  info?(message: string, data?: any): void;
  warn?(message: string, data?: any): void;
  error?(message: string, data?: any): void;
}


export interface CommandProvider {
  /** 受控子进程 runner，供 git、ripgrep、validator 和 fixer 使用。 */
  run(input: CommandRunInput): Promise<CommandRunResult> | CommandRunResult;
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
  toolRequirements?: CommandToolRequirement[];
}

export interface TelemetryProvider {
  emit?(event: { name: string; properties?: Record<string, any>; timestamp?: number }): void | Promise<void>;
}

export interface SandboxProvider {
  create?(input: { root: string; reason?: string }): Promise<{ root: string; dispose?: () => Promise<void> | void }> | { root: string; dispose?: () => Promise<void> | void };
}

export interface ProjectProviders {
  /** 嵌入运行时提供的动态策略、审批和 IO hook。 */
  policy?: PolicyProvider;
  approval?: ApprovalProvider;
  fileFilter?: FileFilterProvider;
  secretRedaction?: SecretRedactionProvider;
  context?: ContextProvider;
  logger?: LoggerProvider;
  command?: CommandProvider;
  telemetry?: TelemetryProvider;
  sandbox?: SandboxProvider;
  /** 可选代码智能后端（由宿主注入，例如 CodeGraph MCP）。 */
  codeIntelligence?: ProjectCodeIntelligenceHost;
}
