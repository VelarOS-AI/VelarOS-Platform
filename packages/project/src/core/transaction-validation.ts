import { isEmpty, isNull, isString, optionalWhen } from "@velaros-ai/core";

import type { FileAdapter } from "../types/adapter.js";
import type { CorePolicy } from "../types/policy.js";
import type { ProjectProviders } from "../types/provider.js";
import type { FileSnapshot } from "../types/snapshot.js";
import type { StoredTransaction } from "../types/transaction.js";
import type { ValidateInput, ValidationResult } from "../types/validation.js";

import type {
  StagedFileContent,
  TransactionContentOverlay,
} from "./transaction-overlay.js";

export interface TransactionValidatorContext {
  readonly root: string;
  readonly policy: CorePolicy;
  readonly providers: ProjectProviders;
  readonly getTransaction: (transactionId: string) => StoredTransaction | undefined;
  readonly readFile: (path: string) => Promise<string | undefined>;
}

export interface TransactionValidationDependencies {
  readonly root: string;
  readonly policy: CorePolicy;
  readonly providers: ProjectProviders;
  readonly getTransaction: (transactionId: string) => StoredTransaction | undefined;
  readonly buildOverlay: (transactionId?: string) => Promise<TransactionContentOverlay>;
  readonly createReader: (
    contentByPath: ReadonlyMap<string, StagedFileContent>,
  ) => (path: string) => Promise<string | undefined>;
  readonly validateRegistered: (
    input: ValidateInput,
    context: TransactionValidatorContext,
  ) => Promise<ValidationResult>;
  readonly createAdapters: (snapshot: FileSnapshot) => Promise<readonly FileAdapter[]>;
  readonly snapshotStaged: (path: string, content: string) => Promise<FileSnapshot>;
  readonly snapshotWorkspace: (path: string) => Promise<FileSnapshot>;
}

/**
 * 在事务未来视图（无事务时为当前工作区）上组合 validator 与文件 adapter 校验。
 *
 * 组件只负责计算 ValidationResult，不推进事务状态、不做权限决策，也不发布 hook、审计或
 * ChangeFeed。事务生命周期仍由 ProjectKernel 统一控制。
 */
export class TransactionValidation {
  public constructor(private readonly dependencies: TransactionValidationDependencies) {}

  public async run(input: ValidateInput): Promise<ValidationResult> {
    const overlay = await this.dependencies.buildOverlay(input.transactionId);
    const context: TransactionValidatorContext = {
      root: this.dependencies.root,
      policy: this.dependencies.policy,
      providers: this.dependencies.providers,
      getTransaction: this.dependencies.getTransaction,
      readFile: this.dependencies.createReader(overlay.contentByPath),
    };
    const result = await this.dependencies.validateRegistered(input, context);

    if (!isEmpty(overlay.diagnostics)) {
      result.diagnostics.push(...overlay.diagnostics);
      result.checks.push({
        id: "core.transaction-replay",
        ok: false,
        diagnostics: overlay.diagnostics,
      });
    }

    const paths = input.paths
      ?? (input.transactionId
        ? this.dependencies.getTransaction(input.transactionId)?.changedFiles ?? []
        : []);
    for (const path of paths) {
      const hasStagedContent = overlay.contentByPath.has(path);
      const stagedContent = optionalWhen(
        hasStagedContent,
        overlay.contentByPath.get(path),
      );
      if (isNull(stagedContent)) continue;
      const snapshot = isString(stagedContent)
        ? await this.dependencies.snapshotStaged(path, stagedContent)
        : await this.dependencies.snapshotWorkspace(path);
      for (const adapter of await this.dependencies.createAdapters(snapshot)) {
        if (!adapter.validate) continue;
        const adapterResult = await adapter.validate({
          snapshot,
          transactionId: input.transactionId,
          changedContent: stagedContent,
        });
        result.diagnostics.push(...adapterResult.diagnostics);
        result.checks.push(...adapterResult.checks);
      }
    }

    return {
      ...result,
      ok: result.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    };
  }
}
