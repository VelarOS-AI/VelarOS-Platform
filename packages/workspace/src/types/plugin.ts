import type { FileAdapterFactory } from "./adapter.js";
import type { WorkspaceFixer } from "./fix.js";
import type { WorkspaceHook } from "./hook.js";
import type { PatchStrategy } from "./patch.js";
import type { PipelineStage } from "./pipeline.js";
import type { WorkspaceValidator } from "./validation.js";

/** 可安装的扩展点集合，用于注册 adapter、strategy、validator、hook 和 fixer。 */
export interface WorkspacePlugin {
  name: string;
  version: string;
  setup(ctx: WorkspacePluginContext): Promise<void> | void;
}

export interface WorkspacePluginContext {
  /** 将能力注册到正在安装该插件的内核中。 */
  registerAdapterFactory(factory: FileAdapterFactory): void;
  registerPatchStrategy(strategy: PatchStrategy): void;
  registerValidator(validator: WorkspaceValidator): void;
  registerFixer(fixer: WorkspaceFixer): void;
  registerHook(hook: WorkspaceHook): void;
  registerPipelineStage(stage: PipelineStage): void;
}
