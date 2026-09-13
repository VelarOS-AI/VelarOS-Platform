import { codeAdapterFactory } from "../adapters/code-adapter.js";
import { jsonAdapterFactory } from "../adapters/json-adapter.js";
import { jsTsAdapterFactory } from "../adapters/jsts-adapter.js";
import { markdownAdapterFactory } from "../adapters/markdown-adapter.js";
import { textAdapterFactory } from "../adapters/text-adapter.js";
import { jsonPatchStrategy } from "../edits/strategies/json-strategy.js";
import { jsTsPatchStrategy } from "../edits/strategies/jsts-strategy.js";
import { textPatchStrategy } from "../edits/strategies/text-strategy.js";
import { PROJECT_PACKAGE_VERSION } from "../runtime/defaults.js";
import type { ProjectPlugin } from "../types/plugin.js";
import { postconditionValidator,scopeValidator } from "../validation/builtin.js";

export function corePlugin(): ProjectPlugin {
  return {
    name: "@velaros-ai/project/core",
    version: PROJECT_PACKAGE_VERSION,
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
