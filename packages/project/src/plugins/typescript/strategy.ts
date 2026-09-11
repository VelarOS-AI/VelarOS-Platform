import { createJsTsPatchStrategy } from "../../patch/jsts-strategy.js";
import type { PatchStrategy } from "../../types/patch.js";

/** TypeScript 插件的补丁策略：与核心 jsts 策略同一实现（符号定位与 import 增删同源），仅以更高优先级注册。 */
export function typescriptPatchStrategy(): PatchStrategy {
  return createJsTsPatchStrategy({ id: "velaros.typescript.symbol-patch", priority: 100 });
}
