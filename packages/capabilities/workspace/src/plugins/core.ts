import { codeAdapterFactory } from "../adapters/code-adapter.js";
import { jsonAdapterFactory } from "../adapters/json-adapter.js";
import { jsTsAdapterFactory } from "../adapters/jsts-adapter.js";
import { markdownAdapterFactory } from "../adapters/markdown-adapter.js";
import { textAdapterFactory } from "../adapters/text-adapter.js";
import { WORKSPACE_PACKAGE_VERSION } from "../core/defaults.js";
import { jsonPatchStrategy } from "../patch/json-strategy.js";
import { jsTsPatchStrategy } from "../patch/jsts-strategy.js";
import { textPatchStrategy } from "../patch/text-strategy.js";
import type { WorkspacePlugin } from "../types/plugin.js";
import { postconditionValidator,scopeValidator } from "../validation/builtin.js";

export function corePlugin(): WorkspacePlugin {
  return {
    name: "@velaros-ai/workspace/core",
    version: WORKSPACE_PACKAGE_VERSION,
    setup(ctx) {
      ctx.registerAdapterFactory(textAdapterFactory());
      ctx.registerAdapterFactory(jsonAdapterFactory());
      ctx.registerAdapterFactory(markdownAdapterFactory());
      ctx.registerAdapterFactory(codeAdapterFactory());
      ctx.registerAdapterFactory(jsTsAdapterFactory());
      ctx.registerPatchStrategy(jsonPatchStrategy());
      ctx.registerPatchStrategy(jsTsPatchStrategy());
      ctx.registerPatchStrategy(textPatchStrategy());
      ctx.registerValidator(scopeValidator());
      ctx.registerValidator(postconditionValidator());
    },
  };
}
