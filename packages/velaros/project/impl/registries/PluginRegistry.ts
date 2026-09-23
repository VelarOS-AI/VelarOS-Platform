/**
 * 插件登记表：`PluginRegistry`。接口 `PluginRegistryApi` 在本文件的类上方。
 * 插件拿到的注册入口就是注入面的 `ProjectPluginContext`，由内核实现。
 */

import type { ProjectPlugin, ProjectPluginContext } from '../../contract/requires.js'

/** 负责安装 plugin，把 plugin setup 里登记的能力接入内核的各个登记表。实例由内核持有，一个内核一份。 */
export interface PluginRegistryApi {
  /**
   * 安装一个插件：同名插件只装一次。插件的 setup 只拿到从 sink 上绑定下来的六个注册函数，碰不到内核本身；
   * setup 抛错时插件不算装上（之后可以重装），错误原样抛出。
   */
  install(plugin: ProjectPlugin, sink: ProjectPluginContext): Promise<void>
  /** 已装上的插件（拷贝的数组），按安装顺序。 */
  list(): ProjectPlugin[]
}

export class PluginRegistry implements PluginRegistryApi {
  private plugins: ProjectPlugin[] = []
  private pluginNames = new Set<string>()

  public async install(plugin: ProjectPlugin, sink: ProjectPluginContext): Promise<void> {
    if (this.pluginNames.has(plugin.name)) return
    this.pluginNames.add(plugin.name)
    // 只暴露绑定过的注册函数，避免 plugin 直接依赖 Project 具体实现。
    const ctx: ProjectPluginContext = {
      registerAdapterFactory: sink.registerAdapterFactory.bind(sink),
      registerPatchStrategy: sink.registerPatchStrategy.bind(sink),
      registerValidator: sink.registerValidator.bind(sink),
      registerFixer: sink.registerFixer.bind(sink),
      registerHook: sink.registerHook.bind(sink),
      registerPipelineStage: sink.registerPipelineStage.bind(sink),
    }
    try {
      await plugin.setup(ctx)
      this.plugins.push(plugin)
    } catch (error) {
      this.pluginNames.delete(plugin.name)
      throw error
    }
  }

  public list(): ProjectPlugin[] {
    return [...this.plugins]
  }
}
