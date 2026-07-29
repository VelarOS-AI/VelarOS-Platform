import { jsTsAdapterFactory } from "../adapters/jsts-adapter.js";
import { WORKSPACE_PACKAGE_VERSION } from "../core/defaults.js";
import { jsTsPatchStrategy } from "../patch/jsts-strategy.js";
import type { WorkspacePlugin } from "../types/plugin.js";

export interface JsTsPluginOptions {
  registerAdapter?: boolean;
  registerPatchStrategy?: boolean;
}

export function jsTsPlugin(options: JsTsPluginOptions = {}): WorkspacePlugin {
  const registerAdapter = options.registerAdapter ?? true;
  const registerPatchStrategy = options.registerPatchStrategy ?? true;
  return {
    name: "@velaros-ai/workspace/jsts",
    version: WORKSPACE_PACKAGE_VERSION,
    setup(ctx) {
      if (registerAdapter) ctx.registerAdapterFactory(jsTsAdapterFactory());
      if (registerPatchStrategy) ctx.registerPatchStrategy(jsTsPatchStrategy());
    },
  };
}

export { findJsTsSymbols,jsTsAdapterFactory } from "../adapters/jsts-adapter.js";
export { jsTsPatchStrategy } from "../patch/jsts-strategy.js";
