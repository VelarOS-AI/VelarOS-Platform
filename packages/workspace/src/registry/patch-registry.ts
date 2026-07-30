import { WorkspaceError } from "../errors.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";

/** 管理补丁策略，并为每次编辑选择优先级最高的可用策略。 */
export class PatchStrategyRegistry {
  private strategies: PatchStrategy[] = [];

  /** 注册一个补丁策略，并按优先级重新排序。 */
  public register(strategy: PatchStrategy): void {
    this.strategies.push(strategy);
    this.strategies.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** 返回当前已注册的补丁策略 id。 */
  public listIds(): string[] {
    return this.strategies.map((s) => s.id);
  }

  /** 选择第一个能处理当前编辑意图的补丁策略。 */
  public select(input: PatchStrategyInput): PatchStrategy {
    const strategy = this.strategies.find((s) => s.canHandle(input));
    if (!strategy) {
      throw new WorkspaceError("NOT_SUPPORTED", `没有 patch strategy 可以处理操作 ${input.intent.operation.type}`);
    }
    return strategy;
  }
}
