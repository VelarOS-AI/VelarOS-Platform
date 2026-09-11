import { createJsTsAdapterFactory } from "../../adapters/jsts-adapter.js";
import type { FileAdapterFactory } from "../../types/adapter.js";

/** TypeScript 插件的 adapter：与核心 jsts adapter 同一实现（同一套 AST 符号），仅以更高优先级注册。 */
export function typescriptAdapterFactory(): FileAdapterFactory {
  return createJsTsAdapterFactory({
    factoryId: "velaros.typescript.factory",
    adapterId: "velaros.typescript.ast",
    priority: 100,
    checkId: "typescript.syntax",
  });
}
