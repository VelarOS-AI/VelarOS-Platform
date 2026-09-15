/**
 * 补丁策略登记表：`PatchStrategyRegistry`。接口 `PatchStrategyRegistryApi` 在本文件的类上方。
 */

import type { PatchStrategy } from '../../contract/requires.js'
import type { PatchStrategyInput } from "../../types/patch.js";
import { ProjectError } from "../../utils/errors.js";

/** 管理补丁策略（插件经 registerPatchStrategy 登记），为每次编辑选优先级最高的可用策略。实例由内核持有，一个内核一份。 */
export interface PatchStrategyRegistryApi {
  /** 登记一个补丁策略，并按 priority 从高到低重新排序（同优先级保持登记顺序）。 */
  register(strategy: PatchStrategy): void;
  /** 已登记的策略号，按优先级从高到低。 */
  listIds(): string[];
  /** 选第一个 canHandle 为真的策略；一个都没有抛 NOT_SUPPORTED。 */
  select(input: PatchStrategyInput): PatchStrategy;
}

export class PatchStrategyRegistry implements PatchStrategyRegistryApi {
  private strategies: PatchStrategy[] = [];

  public register(strategy: PatchStrategy): void {
    this.strategies.push(strategy);
    this.strategies.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  public listIds(): string[] {
    return this.strategies.map((s) => s.id);
  }

  public select(input: PatchStrategyInput): PatchStrategy {
    const strategy = this.strategies.find((s) => s.canHandle(input));
    if (!strategy) {
      throw new ProjectError("NOT_SUPPORTED", `没有 patch strategy 可以处理操作 ${input.intent.operation.type}`);
    }
    return strategy;
  }
}
