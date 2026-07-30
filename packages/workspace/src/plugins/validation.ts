import { isArray, isString } from '@velaros-ai/core'

import { WORKSPACE_PACKAGE_VERSION } from "../core/defaults.js";
import type { WorkspacePlugin } from "../types/plugin.js";
import { commandValidator, type CommandValidatorOptions,eslintFixer, eslintValidator, prettierFixer, prettierValidator, tscValidator } from "../validation/command.js";

export interface ValidationPluginOptions {
  prettier?: boolean | string[];
  eslint?: boolean | string[];
  tsc?: boolean | string[];
  commands?: CommandValidatorOptions[];
}

export function validationPlugin(options: ValidationPluginOptions = {}): WorkspacePlugin {
  return {
    name: "@velaros-ai/workspace/validation",
    version: WORKSPACE_PACKAGE_VERSION,
    setup(ctx) {
      if (options.prettier) {
        const prettierPaths = isArray(options.prettier) ? options.prettier.filter(isString) : undefined;
        ctx.registerValidator(prettierValidator(prettierPaths));
        ctx.registerFixer(prettierFixer(prettierPaths));
      }
      if (options.eslint) {
        const eslintPaths = isArray(options.eslint) ? options.eslint.filter(isString) : undefined;
        ctx.registerValidator(eslintValidator(eslintPaths));
        ctx.registerFixer(eslintFixer(eslintPaths));
      }
      if (options.tsc) {
        const tscPaths = isArray(options.tsc) ? options.tsc.filter(isString) : undefined;
        ctx.registerValidator(tscValidator(tscPaths));
      }
      for (const command of options.commands ?? []) ctx.registerValidator(commandValidator(command));
    },
  };
}

export { commandValidator, eslintFixer, eslintValidator, prettierFixer, prettierValidator, tscValidator } from "../validation/command.js";
