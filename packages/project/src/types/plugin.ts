import type { FileAdapterFactory } from "./adapter.js";
import type { ProjectFixer } from "./fix.js";
import type { ProjectHook } from "./hook.js";
import type { PatchStrategy } from "./patch.js";
import type { PipelineStage } from "./pipeline.js";
import type { ProjectValidator } from "./validation.js";

/** 可安装的扩展点集合，用于注册 adapter、strategy、validator、hook 和 fixer。 */
export interface ProjectPlugin {
  name: string;
  version: string;
  setup(ctx: ProjectPluginContext): Promise<void> | void;
}

export interface ProjectPluginContext {
  /** 将能力注册到正在安装该插件的内核中。 */
  registerAdapterFactory(factory: FileAdapterFactory): void;
  registerPatchStrategy(strategy: PatchStrategy): void;
  registerValidator(validator: ProjectValidator): void;
  registerFixer(fixer: ProjectFixer): void;
  registerHook(hook: ProjectHook): void;
  registerPipelineStage(stage: PipelineStage): void;
}
