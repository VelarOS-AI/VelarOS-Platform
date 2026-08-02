import type { FileAdapterFactory } from "../types/adapter.js";
import type { ProjectFixer } from "../types/fix.js";
import type { ProjectHook } from "../types/hook.js";
import type { PatchStrategy } from "../types/patch.js";
import type { PipelineStage } from "../types/pipeline.js";
import type { ProjectPlugin, ProjectPluginContext } from "../types/plugin.js";
import type { ProjectValidator } from "../types/validation.js";

/** plugin 安装时可写入的注册入口，由 Project 实例实现。 */
export interface RegistrySink {
  registerAdapterFactory(factory: FileAdapterFactory): void;
  registerPatchStrategy(strategy: PatchStrategy): void;
  registerValidator(validator: ProjectValidator): void;
  registerFixer(fixer: ProjectFixer): void;
  registerHook(hook: ProjectHook): void;
  registerPipelineStage(stage: PipelineStage): void;
}

/** 负责安装 plugin，并把 plugin setup 中注册的能力接入内核 registry。 */
export class PluginRegistry {
  private plugins: ProjectPlugin[] = [];
  private pluginNames = new Set<string>();

  /** 安装一个插件，并把插件注册的能力写入目标 registry。 */
  public async install(plugin: ProjectPlugin, sink: RegistrySink): Promise<void> {
    if (this.pluginNames.has(plugin.name)) return;
    this.pluginNames.add(plugin.name);
    // 只暴露绑定过的注册函数，避免 plugin 直接依赖 Project 具体实现。
    const ctx: ProjectPluginContext = {
      registerAdapterFactory: sink.registerAdapterFactory.bind(sink),
      registerPatchStrategy: sink.registerPatchStrategy.bind(sink),
      registerValidator: sink.registerValidator.bind(sink),
      registerFixer: sink.registerFixer.bind(sink),
      registerHook: sink.registerHook.bind(sink),
      registerPipelineStage: sink.registerPipelineStage.bind(sink),
    };
    try {
      await plugin.setup(ctx);
      this.plugins.push(plugin);
    } catch (error) {
      this.pluginNames.delete(plugin.name);
      throw error;
    }
  }

  /** 返回已安装插件的快照列表。 */
  public list(): ProjectPlugin[] {
    return [...this.plugins];
  }
}
