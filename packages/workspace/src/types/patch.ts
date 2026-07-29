import type { EditIntent, PreparedPatch } from "./edit.js";
import type { CorePolicy } from "./policy.js";
import type { FileSnapshot } from "./snapshot.js";
import type { ResolvedTarget } from "./target.js";

/** patch strategy 将编辑 intent 转成 prepared patch 所需的输入。 */
export interface PatchStrategyInput {
  intent: EditIntent;
  target?: ResolvedTarget;
  snapshot?: FileSnapshot;
  policy: CorePolicy;
}

export interface PatchStrategy {
  id: string;
  /** 多个 strategy 都能处理同一 intent 时，priority 更高者优先。 */
  priority?: number;
  canHandle(input: PatchStrategyInput): boolean;
  prepare(input: PatchStrategyInput): Promise<PreparedPatch[]> | PreparedPatch[];
}
