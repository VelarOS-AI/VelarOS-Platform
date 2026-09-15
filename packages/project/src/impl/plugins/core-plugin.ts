import type { ProjectPlugin } from "../../types/plugin.js";
import { codeAdapterFactory } from "../adapters/code-adapter.js";
import { jsonAdapterFactory } from "../adapters/json-adapter.js";
import { jsTsAdapterFactory } from "../adapters/jsts-adapter.js";
import { markdownAdapterFactory } from "../adapters/markdown-adapter.js";
import { textAdapterFactory } from "../adapters/text-adapter.js";
import { PROJECT_PACKAGE_VERSION } from "../kernel/defaults.js";
import { jsonPatchStrategy } from "../strategies/json-strategy.js";
import { jsTsPatchStrategy } from "../strategies/jsts-strategy.js";
import { preparedContentStrategy } from "../strategies/prepared-content-strategy.js";
import { textPatchStrategy } from "../strategies/text-strategy.js";

import { postconditionValidator,scopeValidator } from "./builtin-validators.js";

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
      ctx.registerPatchStrategy(preparedContentStrategy());
      ctx.registerValidator(scopeValidator());
      ctx.registerValidator(postconditionValidator());
    },
  };
}
