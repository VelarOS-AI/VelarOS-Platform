import { isNull } from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";
import { toOptional } from "@velaros-ai/core/utils/nullish";

import type { Diagnostic } from "../types/common.js";
import type { PreparedPatch } from "../types/edit.js";

export type StagedFileContent = Nullable<string>;

export interface TransactionContentOverlay {
  readonly contentByPath: Map<string, StagedFileContent>;
  readonly diagnostics: Diagnostic[];
}

export interface TransactionOverlayDependencies {
  /** 基于前一补丁产出的暂存正文重新推导后继补丁；无法安全推导时返回 null。 */
  readonly rebasePatchAgainstContent: (
    patch: PreparedPatch,
    stagedContent: string,
  ) => Promise<Nullable<PreparedPatch>>;
  /** overlay 未触碰路径时回退到工作区当前正文。 */
  readonly readWorkspaceFile: (path: string) => Promise<string | undefined>;
}

/** 删除类补丁写下后让路径在事务视图中变为不存在。 */
export function isDeletePatch(patch: PreparedPatch): boolean {
  const operation = patch.metadata?.op;
  return operation === "delete_file" || operation === "rename_file_delete";
}

/** 新建类补丁整文件写入，不依赖该路径此前的暂存正文。 */
export function isCreatePatch(patch: PreparedPatch): boolean {
  const operation = patch.metadata?.op;
  return operation === "create_file" || operation === "rename_file_create";
}

/** 补丁写下之后该路径的事务视图；null 与存在但为空的字符串必须严格区分。 */
export function stagedContentAfter(patch: PreparedPatch): StagedFileContent {
  return isDeletePatch(patch) ? null : patch.newContent ?? "";
}

/**
 * 后继补丁的策略坐标属于事务中间态，不再对应事务前原文。移除这些坐标，使跨事务冲突检测
 * 保守地退回同文件冲突，而不是把真实重叠误判为不相交。
 */
export function withoutStagedOffsets(patch: PreparedPatch): PreparedPatch {
  if (!patch.metadata) return patch;
  const { startOffset: _startOffset, endOffset: _endOffset, ...metadata } = patch.metadata;
  return { ...patch, metadata };
}

/**
 * 事务补丁的纯暂存视图。
 *
 * 组件只负责补丁顺序语义与读取覆盖，不查询事务仓库、不执行文件 IO，也不决定 rebase 策略。
 * Kernel 注入的两个回调保留工作区读取与语言感知补丁推导边界。
 */
export class TransactionOverlay {
  public constructor(private readonly dependencies: TransactionOverlayDependencies) {}

  /**
   * 将同一路径的后继补丁衔接到前一补丁产出。创建补丁可以直接重建路径；删除后的其它补丁
   * 无法衔接。只有补丁链断开时才请求 Kernel 基于暂存正文重新推导。
   */
  public async chainPatch(
    patch: PreparedPatch,
    staged: StagedFileContent,
  ): Promise<Nullable<PreparedPatch>> {
    if (isCreatePatch(patch)) return patch;
    if (isNull(staged)) return null;
    if (patch.oldContent === staged) return patch;
    const rebased = await this.dependencies.rebasePatchAgainstContent(patch, staged);
    return rebased ? withoutStagedOffsets(rebased) : null;
  }

  /** 按补丁顺序构造事务未来内容；失败诊断归档后继续检查其余路径。 */
  public async build(
    patches: readonly PreparedPatch[] = [],
  ): Promise<TransactionContentOverlay> {
    const contentByPath = new Map<string, StagedFileContent>();
    const diagnostics: Diagnostic[] = [];

    for (const patch of patches) {
      let chained: Nullable<PreparedPatch>;
      try {
        chained = contentByPath.has(patch.path)
          ? await this.chainPatch(patch, contentByPath.get(patch.path)!)
          : patch;
      } catch (error) {
        // arch-guard:silent-catch-ok 重放失败归档为 transaction diagnostic，由 validate / amend 统一报告。
        diagnostics.push({
          severity: "error",
          path: patch.path,
          source: "core.transaction-replay",
          message: `重放同一文件的后续补丁失败：${AppError.getMessage(error)}`,
        });
        continue;
      }
      if (!chained) {
        diagnostics.push({
          severity: "error",
          path: patch.path,
          source: "core.transaction-replay",
          message: "同一文件的后续补丁无法衔接到前面补丁的结果上，事务不能按顺序重放。",
          data: { patchId: patch.patchId, operation: patch.metadata?.op },
        });
        continue;
      }
      contentByPath.set(patch.path, stagedContentAfter(chained));
    }

    return { contentByPath, diagnostics };
  }

  /** overlay 优先读取；null 表示事务已删除文件，必须读成 undefined 而不是回退磁盘。 */
  public createReader(
    contentByPath: ReadonlyMap<string, StagedFileContent>,
  ): (path: string) => Promise<string | undefined> {
    return async (path) => {
      if (contentByPath.has(path)) return toOptional(contentByPath.get(path));
      return this.dependencies.readWorkspaceFile(path);
    };
  }
}
