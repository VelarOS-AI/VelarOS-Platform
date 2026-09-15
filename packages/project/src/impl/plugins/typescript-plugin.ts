import { ProjectPackageVersion } from "../../contract/constants.js";
import type { ProjectPlugin } from '../../contract/requires.js'
import type { TypeScriptPluginOptions } from '../../types/plugins.js'

import { typescriptAdapterFactory } from "./typescript-adapter.js";
import { typescriptPatchStrategy } from "./typescript-strategy.js";
import { typescriptSyntaxValidator } from "./typescript-validators.js";

export { findJsTsSymbols as findTsSymbols, parseJsTs as parseTs } from "../../utils/jsts-ast.js";
export { typescriptAdapterFactory } from "./typescript-adapter.js";
export { typescriptPatchStrategy } from "./typescript-strategy.js";
export { typescriptSyntaxValidator } from "./typescript-validators.js";

export function typescriptPlugin(options: TypeScriptPluginOptions = {}): ProjectPlugin {
  return {
    name: "@velaros-ai/project-typescript",
    version: ProjectPackageVersion,
    setup(ctx) {
      ctx.registerAdapterFactory(typescriptAdapterFactory());
      ctx.registerPatchStrategy(typescriptPatchStrategy());
      if (options.syntaxValidator ?? true) ctx.registerValidator(typescriptSyntaxValidator());
    },
  };
}
