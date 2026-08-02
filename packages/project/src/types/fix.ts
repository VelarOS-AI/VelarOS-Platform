import type { Diagnostic } from "./common.js";
import type { PreparedTransaction } from "./edit.js";
import type { CommandProvider, CommandToolRequirement, ProjectProviders } from "./provider.js";

/** 在应用 prepared transaction 前请求自动修复。 */
export interface FixInput {
  transactionId: string;
  /** 可选的事务路径子集，只把这些路径交给 fixer。 */
  paths?: string[];
  checks?: string[];
  maxPasses?: number;
}

export interface FixFileContent {
  path: string;
  content: string;
  /** 产生这份替换内容的 fixer 或工具。 */
  source: string;
}

export interface FixResult {
  ok: boolean;
  changed: boolean;
  transactionId: string;
  changedFiles: string[];
  fixes: FixFileContent[];
  diagnostics: Diagnostic[];
  toolRequirements?: CommandToolRequirement[];
}

export interface ProjectFixContext {
  root: string;
  getTransaction(id: string): PreparedTransaction | undefined;
  /** 优先读取事务暂存内容，再回退到工作区文件。 */
  readFile(path: string): Promise<string | undefined>;
  providers: ProjectProviders & { command: CommandProvider };
}

export interface ProjectFixer {
  id: string;
  /** 运行潜在昂贵 fixer 前的低成本适用性检查。 */
  canFix(input: FixInput, ctx: ProjectFixContext): Promise<boolean> | boolean;
  fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> | FixResult;
}
