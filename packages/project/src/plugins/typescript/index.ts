import { PROJECT_PACKAGE_VERSION } from "../../core/defaults.js";
import type { ProjectPlugin } from "../../types/plugin.js";

import { typescriptAdapterFactory } from "./adapter.js";
import { typescriptPatchStrategy } from "./strategy.js";
import { typescriptSyntaxValidator } from "./validators.js";

export { typescriptAdapterFactory } from "./adapter.js";
export { findTsSymbols,parseTs } from "./ast.js";
export { typescriptPatchStrategy } from "./strategy.js";
export { typescriptSyntaxValidator } from "./validators.js";

export interface TypeScriptPluginOptions {
  syntaxValidator?: boolean;
}

export function typescriptPlugin(options: TypeScriptPluginOptions = {}): ProjectPlugin {
  return {
    name: "@velaros-ai/project-typescript",
    version: PROJECT_PACKAGE_VERSION,
    setup(ctx) {
      ctx.registerAdapterFactory(typescriptAdapterFactory());
      ctx.registerPatchStrategy(typescriptPatchStrategy());
      if (options.syntaxValidator ?? true) ctx.registerValidator(typescriptSyntaxValidator());
    },
  };
}
